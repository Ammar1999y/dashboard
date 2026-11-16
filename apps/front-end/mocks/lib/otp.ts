import type { MockRecoveryGrant, MockUser } from '../store';
import type { ContactKind, OtpPurpose } from '@app/shared/validation/enums';
import type * as z from 'zod';

import { sendOtp } from '@app/shared/api/auth';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_BASE_RESEND_DELAY_S } from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';

import { otpRequester, proofs, recoveryGrants, users } from '../store';
import { findProof, issueProof } from './two-factor';
import { MOCK_OTP_CODE, randomToken } from './two-factor-model';

/** Where an anonymous send goes, as the schema every one of them takes parses it. */
export type OtpContact = z.output<typeof sendOtp.body>;

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
/** The server's `OTP_MAX_CHALLENGE_GUESSES`: wrong codes one anonymous code survives. */
const MAX_GUESSES = 3;

/**
 * The server's `requesterFor`: the browser's requester cookie, set on its first
 * anonymous send. Called before the account lookup, as there, since setting it
 * only for a real account would tell one from an invented one.
 */
export function bindRequester(): void {
  if (otpRequester.get() === null) otpRequester.set(randomToken(32));
}

/** One code per purpose, contact and browser: another browser's send leaves it valid. */
const anonymousKey = (
  purpose: OtpPurpose,
  destination: string,
  requester: string
) => `${purpose}:${destination}:${requester}`;

/** Every browser's live code for this purpose and contact. */
const contactCodes = (
  user: MockUser,
  purpose: OtpPurpose,
  destination: string
) => {
  const prefix = anonymousKey(purpose, destination, '');
  return proofs
    .all()
    .filter(
      (proof) =>
        proof.userId === user.id &&
        proof.kind === 'otp' &&
        proof.key.startsWith(prefix) &&
        Date.parse(proof.expiresAt) > Date.now()
    );
};

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
  const requester = otpRequester.get();
  if (requester === null) throw new Error('bindRequester() comes first');
  const key = anonymousKey(purpose, destination, requester);
  const earlier = findProof(user.id, 'otp', key);
  const sends = earlier?.sends ?? 0;
  // The wait is this browser's; the cap is the contact's, as the server's
  // per-destination quota spans every browser.
  const contactSends = contactCodes(user, purpose, destination).reduce(
    (total, proof) => total + proof.sends,
    0
  );
  if (contactSends >= MAX_SENDS) return;
  if (earlier) {
    const elapsed = (Date.now() - Date.parse(earlier.sentAt)) / 1000;
    if (elapsed < OTP_BASE_RESEND_DELAY_S) return;
  }
  issueProof(user.id, 'otp', key, {
    value: MOCK_OTP_CODE,
    sends: sends + 1,
    ttlSeconds: 600,
  });
}

/**
 * The server's `verifyRequesterOtp` behind an anonymous endpoint: only the
 * browser the code was sent to can redeem it, each wrong code spends one of its
 * guesses, and once they are spent the right code fails too. A missing,
 * expired, spent and wrong code are one answer, so none of them says whether
 * the account exists.
 */
export function verifyAnonymousCode(
  user: MockUser,
  purpose: OtpPurpose,
  destination: string,
  code: string
): void {
  const requester = otpRequester.get();
  const proof =
    requester === null
      ? undefined
      : findProof(
          user.id,
          'otp',
          anonymousKey(purpose, destination, requester)
        );
  const guesses = proof?.guesses ?? 0;
  if (!proof || guesses >= MAX_GUESSES) throw invalidOrExpiredCode();
  if (proof.value !== code) {
    proofs.update(proof.id, { guesses: guesses + 1 });
    throw invalidOrExpiredCode();
  }
  // The server's `consumeProof`: the contact is proven, so no browser's code stays live.
  for (const code of contactCodes(user, purpose, destination))
    proofs.remove(code.id);
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
