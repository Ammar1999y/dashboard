import type { MockRecoveryGrant, MockUser } from '../store';
import type { ContactKind, OtpPurpose } from '@app/shared/validation/enums';
import type * as z from 'zod';

import { REQUEST_BODIES } from '@app/shared/contract';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_BASE_RESEND_DELAY_S } from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';

import { recoveryGrants, users } from '../store';
import { findProof, issueProof, verifyCode } from './two-factor';
import { MOCK_OTP_CODE, randomToken } from './two-factor-model';

/** Where an anonymous send goes, as the schema every one of them takes parses it. */
export type OtpContact = z.output<
  (typeof REQUEST_BODIES)['POST /api/auth/otp/send']
>;

/** The contact's value, as the schema normalised it. */
export const destinationOf = (contact: OtpContact) =>
  contact.channel === 'email' ? contact.email : contact.phoneNumber;

/** The server's `activeUserWithContact`: an active account holding this contact. */
export const userWithContact = (contact: OtpContact): MockUser | undefined => {
  const destination = destinationOf(contact);
  return users
    .all()
    .find(
      (user) =>
        user.isActive &&
        (contactKindOf(contact.channel) === 'email'
          ? user.email.toLowerCase() === destination.toLowerCase()
          : user.phoneNumber === destination)
    );
};

/** What every code to an unproven contact says of a code that does not work. */
export const invalidOrExpiredCode = () =>
  new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

const MAX_SENDS = 6;

/**
 * The server's `sendAnonymousOtp` for a known recipient: a send the throttle
 * refuses (too early, or too many) is swallowed, since the answer must not
 * tell a real account from an invented one.
 */
export function sendAnonymousCode(
  user: MockUser,
  purpose: OtpPurpose,
  destination: string
): void {
  const earlier = findProof(user.id, 'otp', `${purpose}:${destination}`);
  const sends = earlier?.sends ?? 0;
  if (earlier) {
    const elapsed = (Date.now() - Date.parse(earlier.sentAt)) / 1000;
    if (elapsed < OTP_BASE_RESEND_DELAY_S || sends >= MAX_SENDS) return;
  }
  issueProof(user.id, 'otp', `${purpose}:${destination}`, {
    value: MOCK_OTP_CODE,
    sends: sends + 1,
    ttlSeconds: 600,
  });
}

/**
 * The server's `processOtpVerify` on an anonymous endpoint: a missing, expired
 * and wrong code are one answer, so none of them says whether the account exists.
 */
export function verifyAnonymousCode(
  user: MockUser,
  purpose: OtpPurpose,
  destination: string,
  code: string
): void {
  try {
    verifyCode(user.id, purpose, destination, code);
  } catch (error) {
    if (!(error instanceof CustomError)) throw error;
    throw invalidOrExpiredCode();
  }
}

/** The server's `markContactVerified`. */
export function markContactVerified(user: MockUser, kind: ContactKind): void {
  users.update(
    user.id,
    kind === 'email' ? { emailVerified: true } : { phoneNumberVerified: true }
  );
}

/** Seconds a recovery grant stays good, as the server's `RECOVERY_GRANT_MAX_AGE_S`. */
const RECOVERY_GRANT_TTL_S = 900;
const RECOVERY_ALLOWED_ATTEMPTS = 5;

/** The server's `issueRecoveryGrant`. */
export function issueRecoveryGrant(
  user: MockUser,
  excludeContactKind: ContactKind,
  optionIds: readonly string[]
): string {
  const token = randomToken(24);
  recoveryGrants.insert({
    id: token,
    userId: user.id,
    excludeContactKind,
    options: [...optionIds],
    attempts: 0,
    expiresAt: new Date(Date.now() + RECOVERY_GRANT_TTL_S * 1000).toISOString(),
  });
  return token;
}

/**
 * The server's `resolveRecoveryOption`: a live grant, and an option from the
 * set it was issued with. Anything else is the one answer for a bad code.
 */
export function resolveRecoveryGrant(
  token: string,
  optionId: string
): MockRecoveryGrant {
  const grant = recoveryGrants.find(token);
  if (
    !grant ||
    Date.parse(grant.expiresAt) <= Date.now() ||
    !grant.options.includes(optionId)
  )
    throw invalidOrExpiredCode();
  return grant;
}

/** Spends an attempt before a guess; the sixth ends the grant. */
export function beginRecoveryAttempt(grant: MockRecoveryGrant): void {
  if (grant.attempts < RECOVERY_ALLOWED_ATTEMPTS) return;
  recoveryGrants.remove(grant.id);
  throw new CustomError(
    otpMsg.recoveryAttemptsExhausted,
    HTTP_STATUS.BAD_REQUEST
  );
}

export function recordRecoveryFailure(grant: MockRecoveryGrant): void {
  recoveryGrants.update(grant.id, { attempts: grant.attempts + 1 });
}
