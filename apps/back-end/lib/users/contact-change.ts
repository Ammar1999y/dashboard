import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { HandlerCookie } from '@/lib/http/contract';
import type { EntityID } from '@app/shared/types';
import type { ContactKind, OtpChannel } from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';

import { auditLog } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { verifyLoginAttempt } from '@/lib/auth/login-guard';
import { twoFactorMsg } from '@/lib/auth/messages';
import { requireReauthWindow } from '@/lib/auth/reauth/window';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/session/rotation';
import {
  contactChangeStrandsTwoFactor,
  removeMethodIntent,
} from '@/lib/auth/two-factor/methods';
import { parseSetCookieHeaders } from '@/lib/http/cookies';
import { notFoundError } from '@/lib/http/response';
import { markContactVerified } from '@/lib/otp/contact';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { enforceOtpSurfaceSendQuota } from '@/lib/rate-limit';

import { logSanitized } from '@/utils/log';

import { asCurrentPasswordIncorrect } from './current-password';
import { activeUser, liveUser } from './filters';
import { userMsg } from './messages';

export async function assertContactChangeKeepsFactor(
  tx: Tx,
  userId: EntityID,
  contactKinds: readonly ContactKind[]
): Promise<void> {
  if (await contactChangeStrandsTwoFactor(userId, contactKinds, tx))
    throw new CustomError(
      twoFactorMsg.contactChangeStrands,
      HTTP_STATUS.CONFLICT
    );
}

/**
 * The second-factor half of a contact change, at the boundary BOTH commits pass
 * through.
 *
 * ⚠️ Three rules:
 *
 *  1. `two_factor_enabled` is never touched. Invalidating the `otp` enrolment
 *     can leave a user enabled with an empty offered set, and clearing the flag
 *     to tidy that up makes an ordinary contact edit a 2FA disarm.
 *  2. The change is REFUSED when it would remove the last usable factor, which
 *     keeps rule 1 from stranding anyone; the way out is the administrative
 *     reset, with its permission and audit trail.
 *  3. Otherwise the OTP enrolment bound to the OLD contact is invalidated, or
 *     the factor would silently re-arm at the new address, which the user
 *     never chose as a second factor.
 */
async function detachTwoFactorFromContact(
  tx: Tx,
  userId: EntityID,
  contactKind: ContactKind
): Promise<void> {
  await assertContactChangeKeepsFactor(tx, userId, [contactKind]);
  await removeMethodIntent(tx, userId, 'otp', contactKind);
}

/**
 * Reads uncached session state so a revoked email-change session clears its
 * cookies. Non-fatal: the revocation has already committed.
 */
export async function refreshSessionCookies(
  headers: Headers
): Promise<HandlerCookie[] | undefined> {
  try {
    const refreshed = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const cookies = parseSetCookieHeaders(refreshed.headers.getSetCookie());
    return cookies.length > 0 ? cookies : undefined;
  } catch (e) {
    logSanitized('error', { msg: 'session.cookieRefresh failed', error: e });
    return undefined;
  }
}

/**
 * The caller of a contact change proves it is still them: the supplied current
 * password, or an open re-authentication window when none is supplied. Run
 * before the mutation's transaction, so no row lock is held across Argon2.
 */
async function reauthenticateContactChange(opts: {
  userId: EntityID;
  sessionId: EntityID;
  currentPassword: string | undefined;
  auditMeta: AuditMeta;
  purpose: 'reauth_change_email' | 'reauth_change_phone';
}): Promise<void> {
  try {
    if (opts.currentPassword === undefined)
      await requireReauthWindow(opts.userId, opts.sessionId);
    else
      await verifyLoginAttempt({
        userId: opts.userId,
        password: opts.currentPassword,
        // The floor guards anonymous enumeration; this caller holds a session.
        skipTimingGuard: true,
        auditMeta: opts.auditMeta,
        purpose: opts.purpose,
      });
  } catch (error) {
    throw asCurrentPasswordIncorrect(error);
  }
}

/**
 * Every refusal a contact change owes before its code is sent or, under
 * OTP_AUTO_VERIFY, before it commits.
 *
 * A TAKEN value is not refused here: saying so before ownership is proven
 * would be an enumeration oracle. The unique index decides at commit (409);
 * only same-as-current, which reveals nothing, is refused.
 */
export async function authorizeContactChange(opts: {
  kind: ContactKind;
  userId: EntityID;
  sessionId: EntityID;
  currentPassword: string | undefined;
  newValue: string;
  auditMeta: AuditMeta;
}): Promise<void> {
  const isEmail = opts.kind === 'email';
  await reauthenticateContactChange({
    userId: opts.userId,
    sessionId: opts.sessionId,
    currentPassword: opts.currentPassword,
    auditMeta: opts.auditMeta,
    purpose: isEmail ? 'reauth_change_email' : 'reauth_change_phone',
  });

  const [currentUser] = await db
    .select({
      contact: isEmail ? users.email : users.phoneNumber,
      roleId: users.roleId,
      isActive: users.isActive,
    })
    .from(users)
    .where(liveUser(eq(users.id, opts.userId)))
    .limit(1);

  if (!currentUser || !currentUser.isActive) throw notFoundError();
  if (!currentUser.roleId) throw insufficientPermissions();
  if (currentUser.contact === opts.newValue)
    throw new CustomError(
      isEmail ? userMsg.newEmailSameAsCurrent : userMsg.newPhoneSameAsCurrent,
      HTTP_STATUS.BAD_REQUEST
    );
}

/**
 * AWAITED, unlike the anonymous surfaces, which defer delivery to keep a
 * constant-time generic 200. This caller is authenticated and waiting for the
 * code, so `otpSent: true` must mean the provider accepted it; the provider
 * calls are bounded, so the wait is too.
 */
export async function sendContactChangeCode(
  userId: EntityID,
  channel: OtpChannel,
  destination: string
): Promise<void> {
  const kind = contactKindOf(channel);
  // Keyed on the contact kind: `sms` and `whatsapp` share one per-destination
  // budget, so switching transport does not double the paid messages one
  // number can be sent.
  await enforceOtpSurfaceSendQuota({
    channel,
    destination,
    surface: 'contact_change',
  });
  await processOtpSend({
    userId,
    identifier: destination,
    channel,
    purpose: kind === 'email' ? 'change_email' : 'change_phone',
    targetIdentifier: destination,
    sendTo: destination,
    entityName: CONTACT_LABEL[kind],
  });
}

interface CommitContactChangeOpts {
  tx: Tx;
  userId: EntityID;
  /** Auth session to preserve; all the user's other sessions are revoked. */
  keepSessionId?: string | null;
  /**
   * The verification session being consumed right now. It survives the
   * sibling-proof purge so the caller can still stamp it verified/consumed;
   * every other pending proof for this user is dropped.
   */
  keepVerificationSessionId?: string | null;
  auditMeta: AuditMeta;
}

interface CommitEmailChangeOpts extends Omit<
  CommitContactChangeOpts,
  'keepSessionId'
> {
  newEmail: string;
}

/**
 * Atomically commits a verified contact change, inside `processOtpVerify`'s
 * transaction or, under OTP_AUTO_VERIFY, a fresh one.
 *
 * Where the verified flag may be set true: alongside a NEW address only in the
 * one `UPDATE` below that writes the address, since splitting them would leave
 * a new address with the old flag; on an UNCHANGED address only through
 * `markContactVerified`. Clearing it is unrestricted.
 *
 * A unique violation (address taken) propagates; the caller maps it to 409.
 */
export async function commitEmailChange({
  tx,
  userId,
  newEmail,
  keepVerificationSessionId,
  auditMeta,
}: CommitEmailChangeOpts): Promise<void> {
  // A fresh read under FOR UPDATE: a concurrently deactivated or demoted user
  // must not rotate their email inside the cookie-cache staleness window.
  const [current] = await tx
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      roleId: users.roleId,
    })
    .from(users)
    .where(activeUser(eq(users.id, userId)))
    .for('update');

  if (!current) throw notFoundError();
  if (!current.roleId) throw insufficientPermissions();

  // Already committed (a duplicate verify after an auto-verify), so only the
  // flag can be missing; `markContactVerified` writes its audit row.
  if (current.email === newEmail) {
    await markContactVerified(tx, {
      userId,
      channel: 'email',
      auditMeta,
      onMissing: () => {
        throw notFoundError();
      },
    });
    return;
  }

  await detachTwoFactorFromContact(tx, userId, 'email');

  await tx
    .update(users)
    .set({ email: newEmail, emailVerified: true })
    .where(eq(users.id, userId));

  await unlinkGoogle(tx, userId, auditMeta);
  await revokeOtherSessions(tx, userId);
  await revokePendingProofs(tx, userId, keepVerificationSessionId);

  await auditLog(tx, {
    userId,
    userEmail: current.email,
    action: 'UPDATE',
    tableName: 'users',
    recordId: userId,
    oldData: { email: current.email, emailVerified: current.emailVerified },
    newData: { email: newEmail, emailVerified: true },
    meta: auditMeta,
  });
}

interface CommitPhoneChangeOpts extends CommitContactChangeOpts {
  newPhoneNumber: string;
}

export async function commitPhoneChange({
  tx,
  userId,
  newPhoneNumber,
  keepSessionId,
  keepVerificationSessionId,
  auditMeta,
}: CommitPhoneChangeOpts): Promise<void> {
  const [current] = await tx
    .select({
      email: users.email,
      phoneNumber: users.phoneNumber,
      phoneNumberVerified: users.phoneNumberVerified,
      roleId: users.roleId,
    })
    .from(users)
    .where(activeUser(eq(users.id, userId)))
    .for('update');

  if (!current) throw notFoundError();
  if (!current.roleId) throw insufficientPermissions();

  // Same idempotent branch as the email flow — see `commitEmailChange`.
  if (current.phoneNumber === newPhoneNumber) {
    await markContactVerified(tx, {
      userId,
      // Any phone channel: `sms` and `whatsapp` name the same
      // `phone_number_verified` flag.
      channel: 'sms',
      auditMeta,
      onMissing: () => {
        throw notFoundError();
      },
    });
    return;
  }

  await detachTwoFactorFromContact(tx, userId, 'phone');

  await tx
    .update(users)
    .set({ phoneNumber: newPhoneNumber, phoneNumberVerified: true })
    .where(eq(users.id, userId));

  // The phone is a passwordless login factor, so replacing it is a credential
  // rotation: a session obtained through the OLD number must not outlive it.
  await revokeOtherSessions(tx, userId, keepSessionId);
  await revokePendingProofs(tx, userId, keepVerificationSessionId);

  await auditLog(tx, {
    userId,
    userEmail: current.email,
    action: 'UPDATE',
    tableName: 'users',
    recordId: userId,
    oldData: {
      phoneNumber: current.phoneNumber,
      phoneNumberVerified: current.phoneNumberVerified,
    },
    newData: { phoneNumber: newPhoneNumber, phoneNumberVerified: true },
    meta: auditMeta,
  });
}
