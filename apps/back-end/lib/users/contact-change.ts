import type { Executor, Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type { ContactKind, OtpChannel } from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';

import { auditLog } from '@/lib/audit';
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
import { notFoundError } from '@/lib/http/response';
import { markContactVerified } from '@/lib/otp/contact';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import { insufficientPermissions } from '@/lib/permissions/checker';
import { enforceOtpSurfaceSendQuota } from '@/lib/rate-limit';

import { asCurrentPasswordIncorrect } from './current-password';
import { activeUser, liveUser } from './filters';
import { userMsg } from './messages';

export async function assertContactChangeKeepsFactor(
  executor: Executor,
  userId: EntityID,
  contactKinds: readonly ContactKind[]
): Promise<void> {
  if (await contactChangeStrandsTwoFactor(userId, contactKinds, executor))
    throw new CustomError(
      twoFactorMsg.contactChangeStrands,
      HTTP_STATUS.CONFLICT
    );
}

/**
 * ⚠️ Never touches `two_factor_enabled`: clearing it would make a contact edit a
 * 2FA disarm. The old contact's OTP enrolment goes, or it would re-arm at the
 * new address.
 */
async function detachTwoFactorFromContact(
  tx: Tx,
  userId: EntityID,
  contactKind: ContactKind
): Promise<void> {
  await assertContactChangeKeepsFactor(tx, userId, [contactKind]);
  await removeMethodIntent(tx, userId, 'otp', contactKind);
}

// Before the mutation's transaction, so no row lock is held across Argon2.
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

// A taken value is not refused here — before ownership is proven that is an
// enumeration oracle. The unique index decides at commit.
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

  // Only spares the send; the commit's check under the row lock is the gate.
  await assertContactChangeKeepsFactor(db, opts.userId, [opts.kind]);
}

// Awaited, unlike anonymous sends: authenticated, so `otpSent: true` must mean
// the provider accepted it. The provider calls are bounded, so the wait is too.
export async function sendContactChangeCode(
  userId: EntityID,
  channel: OtpChannel,
  destination: string
): Promise<void> {
  const kind = contactKindOf(channel);
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
  /** Survives the purge so the caller can still stamp it consumed. */
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
 * ⚠️ The verified flag is set true only in the same `UPDATE` as a new address,
 * or via `markContactVerified` for an unchanged one. A unique violation
 * propagates; the caller maps it to 409.
 */
export async function commitEmailChange({
  tx,
  userId,
  newEmail,
  keepVerificationSessionId,
  auditMeta,
}: CommitEmailChangeOpts): Promise<void> {
  // Fresh, under lock: the cookie cache may predate a deactivation or demotion.
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

  // Already committed (a duplicate verify); only the flag can be missing.
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

  await unlinkGoogle(tx, userId, { userId, email: newEmail }, auditMeta);
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
      // Any phone channel names the same flag.
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

  // The phone is a passwordless factor, so this is a credential rotation.
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
