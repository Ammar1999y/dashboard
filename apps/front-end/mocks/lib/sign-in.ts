import type { MockSession, MockUser } from '../store';
import type { OfferedOption } from './two-factor-model';
import type {
  ContactKind,
  TwoFactorMethod,
} from '@app/shared/validation/enums';

import {
  REQUIRE_EMAIL_VERIFICATION,
  REQUIRE_PHONE_VERIFICATION,
} from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import {
  EMAIL_NOT_VERIFIED_CODE,
  PHONE_NOT_VERIFIED_CODE,
  TWO_FACTOR_UNAVAILABLE_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_EMAIL_NOT_VERIFIED,
  MSG_INVALID_CREDENTIALS,
  MSG_PHONE_NOT_VERIFIED,
  twoFactorMsg,
} from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';
import { TWO_FACTOR_ENABLED } from '@app/shared/validation/two-factor';

import { generateEntityId } from '@/utils/generate-id';

import { challenge, session, users } from '../store';
import { now } from './db';
import { mayHoldSession } from './permissions';
import {
  enrolmentOf,
  findProof,
  markTwoFactorProven,
  resendWait,
  twoFactorOf,
  writeTwoFactor,
} from './two-factor';
import { defaultOption, offeredMethods } from './two-factor-model';

const SESSION_DAYS = 7;

/** Starts the one session the mocks hold, for `user`. */
export function startSession(user: MockUser): MockSession {
  const createdAt = now();
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 86_400_000
  ).toISOString();

  const next: MockSession = {
    session: {
      id: generateEntityId(),
      token: generateEntityId(),
      userId: user.id,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    },
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified ?? false,
      image: null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
  session.set(next);
  return next;
}

/**
 * The server's `session.create.before`, which every first factor passes: the
 * account and its role must allow a login, and where the deployment requires a
 * verified contact, the distinct code the client routes on comes after that.
 */
export function admitSession(user: MockUser): void {
  if (!mayHoldSession(user))
    throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
  if (REQUIRE_EMAIL_VERIFICATION && EMAIL_OTP_AVAILABLE && !user.emailVerified)
    throw new CustomError(
      MSG_EMAIL_NOT_VERIFIED,
      HTTP_STATUS.FORBIDDEN,
      EMAIL_NOT_VERIFIED_CODE
    );
  if (
    REQUIRE_PHONE_VERIFICATION &&
    PHONE_OTP_AVAILABLE &&
    !user.phoneNumberVerified
  )
    throw new CustomError(
      MSG_PHONE_NOT_VERIFIED,
      HTTP_STATUS.FORBIDDEN,
      PHONE_NOT_VERIFIED_CODE
    );
}

/** The server's `twoFactorUnavailableError`: a second factor the account cannot complete. */
export const twoFactorUnavailable = () =>
  new CustomError(
    twoFactorMsg.twoFactorUnavailable,
    HTTP_STATUS.FORBIDDEN,
    TWO_FACTOR_UNAVAILABLE_CODE
  );

const challengeMissing = () =>
  new CustomError(twoFactorMsg.challengeMissing, HTTP_STATUS.UNAUTHORIZED);

/** The server's `TWO_FACTOR_CHALLENGE_MAX_AGE_S`. */
const CHALLENGE_TTL_S = 600;
/** The server's `TWO_FACTOR_ALLOWED_ATTEMPTS`. */
const ALLOWED_ATTEMPTS = 5;
const TRUSTED_DEVICE_DAYS = 30;

const deviceAgent = () => globalThis.navigator?.userAgent ?? null;

/**
 * The server's `consumeDeviceTrust`. The cookie that names a trusted device is
 * not visible here, so a device stands in for it by the user agent it was
 * saved with. A use renews it.
 */
function consumeDeviceTrust(user: MockUser): boolean {
  const { trustedDevices } = twoFactorOf(user.id);
  const live = (device: (typeof trustedDevices)[number]) =>
    device.userAgent === deviceAgent() &&
    Date.parse(device.expiresAt) > Date.now();
  if (!trustedDevices.some((device) => live(device))) return false;

  const at = now();
  writeTwoFactor(user.id, {
    trustedDevices: trustedDevices.map((device) =>
      live(device)
        ? {
            ...device,
            lastUsedAt: at,
            expiresAt: new Date(
              Date.now() + TRUSTED_DEVICE_DAYS * 86_400_000
            ).toISOString(),
          }
        : device
    ),
  });
  return true;
}

/** Seconds before a code may go to this option's contact, from the sends so far. */
function sendWait(user: MockUser, option: OfferedOption): number {
  const destination =
    option.contactKind === 'phone' ? user.phoneNumber : user.email;
  const proof =
    destination && findProof(user.id, 'otp', `two_factor:${destination}`);
  if (!proof) return 0;
  return resendWait(proof);
}

export interface ChallengeBody {
  twoFactorRedirect: true;
  twoFactorMethods: TwoFactorMethod[];
  twoFactorOptions: (OfferedOption & { nextAllowedIn?: number })[];
  defaultMethod: string | null;
}

export type ChallengeOutcome =
  | { kind: 'proceed' }
  | { kind: 'challenge'; body: ChallengeBody }
  /** Fails closed: an empty set is never a reason to skip the second factor. */
  | { kind: 'refused' };

/**
 * The server's `issueTwoFactorChallenge`, the only issuer: after any first
 * factor it decides between a session, a challenge, and a refusal. A challenge
 * is held in place of the cookie and a trusted device is a way past it, except
 * after Google, which the account has not proven a factor with.
 */
export function issueChallenge(
  user: MockUser,
  {
    firstFactor,
    rememberMe,
    excludeContactKind,
  }: {
    firstFactor: 'password' | 'passwordless' | 'google';
    rememberMe: boolean;
    excludeContactKind?: ContactKind;
  }
): ChallengeOutcome {
  if (!TWO_FACTOR_ENABLED) return { kind: 'proceed' };
  const state = enrolmentOf(user);
  if (!state.enabled) return { kind: 'proceed' };

  const options = offeredMethods(state, excludeContactKind);
  if (options.length === 0) return { kind: 'refused' };
  if (firstFactor !== 'google' && consumeDeviceTrust(user))
    return { kind: 'proceed' };

  const defaultMethod = defaultOption(options);
  challenge.set({
    userId: user.id,
    options: options.map(({ id }) => id),
    defaultMethod,
    firstFactor,
    excludeContactKind: excludeContactKind ?? null,
    rememberMe,
    attempts: 0,
    ceremony: null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_S * 1000).toISOString(),
  });
  return {
    kind: 'challenge',
    body: {
      twoFactorRedirect: true,
      twoFactorMethods: [...new Set(options.map(({ method }) => method))],
      twoFactorOptions: options.map((option) =>
        option.method === 'otp'
          ? { ...option, nextAllowedIn: sendWait(user, option) }
          : option
      ),
      defaultMethod,
    },
  };
}

/**
 * The server's `requireTwoFactorChallenge`. The challenge is gone once it
 * expires, once the account is, and once an attempt budget ends it; what is
 * offered is the issued set narrowed by what the account can do now.
 * `signInOnly` is for the library's verifiers, which a session may not reach.
 */
export function requireChallenge({
  method,
  signInOnly = false,
}: { method?: TwoFactorMethod; signInOnly?: boolean } = {}) {
  if (signInOnly && session.get())
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);

  const issued = challenge.get();
  const user = issued && users.find(issued.userId);
  if (!issued || Date.parse(issued.expiresAt) <= Date.now() || !user?.isActive)
    throw challengeMissing();

  const issuedIds = new Set(issued.options);
  const options = offeredMethods(enrolmentOf(user)).filter(({ id }) =>
    issuedIds.has(id)
  );
  if (method && !options.some((option) => option.method === method))
    throw new CustomError(
      twoFactorMsg.methodUnavailable,
      HTTP_STATUS.BAD_REQUEST
    );
  return { issued, user, options };
}

/**
 * The server's `spendChallengeAttempt`, before a guess is compared: the sixth
 * ends the whole challenge, which is why switching method buys nothing.
 */
export function beginAttempt(): void {
  const issued = challenge.get();
  if (!issued) throw challengeMissing();
  if (issued.attempts < ALLOWED_ATTEMPTS) return;
  challenge.set(null);
  throw new CustomError(twoFactorMsg.tooManyAttempts, HTTP_STATUS.BAD_REQUEST);
}

/** A guess that was compared and lost; anything else is refunded by doing nothing. */
export function recordFailure(): void {
  const issued = challenge.get();
  if (issued) challenge.set({ ...issued, attempts: issued.attempts + 1 });
}

/**
 * The server's `completeTwoFactorChallenge`: the session the first factor held
 * back, and the proof that lets this device be remembered once.
 */
export function completeChallenge(user: MockUser): MockSession {
  const started = startSession(user);
  challenge.set(null);
  markTwoFactorProven(user.id, started.session.id);
  return started;
}
