import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { OtpPurpose } from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { verificationSessions } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_BASE_RESEND_DELAY_S } from '@app/shared/validation/constants';

import { OTP_BLOCK_DURATION_HOURS } from './limits';

/**
 * Anonymous sends answer one body for real and invented identifiers, so they can
 * only advertise a constant delay; a ladder would silently refuse clients that
 * obey it. The other send caps cover what the ladder would add.
 */
const FLAT_RESEND_PURPOSE_LIST = [
  'verify_contact',
  'passwordless_login',
  'forgot_password',
] as const satisfies readonly OtpPurpose[];

export type FlatResendPurpose = (typeof FLAT_RESEND_PURPOSE_LIST)[number];

const FLAT_RESEND_PURPOSES: ReadonlySet<OtpPurpose> = new Set(
  FLAT_RESEND_PURPOSE_LIST
);

export function calculateNextAllowedAt(
  attemptNumber: number,
  purpose: OtpPurpose
): Date {
  const delaySeconds = FLAT_RESEND_PURPOSES.has(purpose)
    ? OTP_BASE_RESEND_DELAY_S
    : OTP_BASE_RESEND_DELAY_S * Math.pow(2, attemptNumber - 1);
  return new Date(Date.now() + delaySeconds * 1000);
}

export function calculateBlockDuration(): Date {
  return new Date(Date.now() + OTP_BLOCK_DURATION_HOURS * 60 * 60 * 1000);
}

/**
 * ⚠️ Both per-cycle counters must clear, or the next request re-blocks forever.
 * `verifyAttemptDaily` is deliberately absent: it ages out on its own anchor.
 */
export const BLOCK_EXPIRY_RESET = {
  isBlocked: false,
  blockedUntil: null,
  attemptNumber: 0,
  verifyAttemptNumber: 0,
} as const;

/**
 * A fresh code restarts the guess counter; `verifyAttemptDaily` and
 * `attemptNumber` survive, so the daily and send caps still re-block. The
 * verify-side block message promises this.
 */
export const VERIFY_BLOCK_CLEARED_BY_RESEND = {
  isBlocked: false,
  blockedUntil: null,
  verifyAttemptNumber: 0,
} as const;

export async function blockSession(
  tx: Tx,
  sessionId: EntityID,
  blockedUntil: Date
): Promise<void> {
  await tx
    .update(verificationSessions)
    .set({ isBlocked: true, blockedUntil })
    .where(eq(verificationSessions.id, sessionId));
}

/**
 * A proof-row 429, as opposed to a limiter's: only an existing account has a
 * proof row, so on an anonymous endpoint it is an existence test.
 */
const OTP_PROOF_THROTTLE_CODE = 'otp_proof_throttle';

export function blockedError(message: string, until: Date | null): CustomError {
  const error = new CustomError(
    message,
    HTTP_STATUS.TOO_MANY_REQUESTS,
    OTP_PROOF_THROTTLE_CODE
  );
  const seconds = until
    ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000))
    : OTP_BLOCK_DURATION_HOURS * 3600;
  error.responseHeaders = { 'Retry-After': String(seconds) };
  return error;
}

// For anonymous boundaries only; authenticated ones keep the real `Retry-After`.
export function collapseProofThrottle(
  error: unknown,
  genericMessage: string
): unknown {
  if (error instanceof CustomError && error.code === OTP_PROOF_THROTTLE_CODE)
    return new CustomError(genericMessage, HTTP_STATUS.BAD_REQUEST);
  return error;
}

// A 429 or 422 never depends on whether the account exists, the 429 only
// because a proof-state 429 is collapsed first (`collapseProofThrottle` below):
// this is the one guard. A 5xx does when a known account's transaction raised
// it, which no request can cause at will, and a server fault must not read as a
// wrong code.
const ANONYMOUS_VERIFY_SURFACED: ReadonlySet<number> = new Set([
  HTTP_STATUS.TOO_MANY_REQUESTS,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.INTERNAL_ERROR,
  HTTP_STATUS.UNPROCESSABLE,
]);

/** `alsoSurface` is for a refusal only a correct code can reach. */
export function collapseAnonymousVerifyError(
  error: unknown,
  genericMessage: string,
  alsoSurface: readonly number[] = []
): unknown {
  const collapsed = collapseProofThrottle(error, genericMessage);
  if (!(collapsed instanceof CustomError)) return collapsed;
  const { status } = collapsed;
  if (
    status !== undefined &&
    (ANONYMOUS_VERIFY_SURFACED.has(status) || alsoSurface.includes(status))
  )
    return collapsed;
  const generic = new CustomError(genericMessage, HTTP_STATUS.BAD_REQUEST);
  generic.responseHeaders = collapsed.responseHeaders;
  return generic;
}

export function invalidOrExpiredCode(): CustomError {
  return new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);
}
