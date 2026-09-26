import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { HandlerCookie } from '@/lib/http/contract';
import type { EntityID } from '@app/shared/types';

import { and, eq, isNull } from 'drizzle-orm';

import { users } from '@/db/schema';

import { HTTP_STATUS, MSG_NOT_FOUND } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { auditLog } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { twoFactorMsg } from '@/lib/auth/messages';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/session/rotation';
import {
  contactChangeStrandsTwoFactor,
  removeMethodIntent,
} from '@/lib/auth/two-factor/methods';
import { parseSetCookieHeaders } from '@/lib/http/contract';
import { markContactVerified } from '@/lib/otp/contact';
import { insufficientPermissions } from '@/lib/permissions/checker';

import { sanitizeForLog } from '@/utils/log';

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
  contactKind: 'email' | 'phone'
): Promise<void> {
  if (await contactChangeStrandsTwoFactor(userId, [contactKind], tx))
    throw new CustomError(
      twoFactorMsg.contactChangeStrands,
      HTTP_STATUS.CONFLICT
    );
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
    console.error(
      sanitizeForLog({ msg: 'session.cookieRefresh failed', error: e })
    );
    return undefined;
  }
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
    .where(
      and(
        eq(users.id, userId),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    )
    .for('update');

  if (!current) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  if (!current.roleId) throw insufficientPermissions();

  // Already committed (a duplicate verify after an auto-verify), so only the
  // flag can be missing; `markContactVerified` writes its audit row.
  if (current.email === newEmail) {
    await markContactVerified(tx, {
      userId,
      channel: 'email',
      auditMeta,
      onMissing: () => {
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
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
    .where(
      and(
        eq(users.id, userId),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    )
    .for('update');

  if (!current) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
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
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
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
