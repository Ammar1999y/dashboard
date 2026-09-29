import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { OtpPurpose } from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { verificationSessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { otpMsg } from '@/lib/auth/messages';

import { OTP_BLOCK_DURATION_HOURS } from './limits';

/** The first rung, and the whole ladder on the anonymous surfaces. */
export const OTP_BASE_RESEND_DELAY_S = 30;

/**
 * Purposes whose send endpoint answers the SAME body for a real identifier and
 * an invented one, so it cannot report this row's own countdown.
 *
 * That privacy contract and an exponential ladder are not compatible: the
 * response can only advertise a constant, and a client obeying it would have
 * every request past the first refused INTERNALLY — answered with the same
 * generic success, a destination quota unit spent and nothing delivered. Flat
 * makes the advertised number true, and the other bounds already cover what the
 * ladder would add: `OTP_MAX_ATTEMPTS` per cycle,
 * `OTP_SURFACE_SEND_CAP_PER_HOUR` per destination (`lib/rate-limit`), and the
 * global daily breaker.
 *
 * The authenticated surfaces (`/two-factor/otp/send`, the recovery second
 * factor) keep the ladder: they return the row's real `nextAllowedIn`.
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
 * The single definition of "this block has been served".
 *
 * BOTH per-cycle counters must clear, from every entry path. Clearing only the
 * counter the current path cares about leaves the other at its cap, so the
 * very next request re-blocks for another full duration and the penalty never
 * actually ends. `verifyAttemptDaily` and its window are deliberately absent:
 * that bound ages out on its own anchor, not on block expiry.
 */
export const BLOCK_EXPIRY_RESET = {
  isBlocked: false,
  blockedUntil: null,
  attemptNumber: 0,
  verifyAttemptNumber: 0,
} as const;

/**
 * What a send does to a LIVE block. A fresh code replaces the one the verify
 * block was protecting, so the per-cycle guess counter restarts with it; the
 * block is not a bound in its own right. `verifyAttemptDaily` survives, so the
 * daily cap still re-blocks, and `attemptNumber` survives, so the send path
 * re-derives a send-side block from it. The verify-side block message promises
 * exactly this: a new code lifts it.
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
 * Marks a 429 that came from PROOF-ROW state rather than from a limiter.
 *
 * The distinction is a disclosure boundary. A proof row exists only for an
 * account that exists, so its throttle is account-dependent: surfaced on an
 * anonymous endpoint, the block after a cycle's last wrong code is a
 * CAPTCHA-solvable existence test. The pre-lookup IP and destination limiters
 * carry no marker and keep their 429, because they fire for real and fake
 * identifiers alike.
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

/**
 * Collapse an account-dependent proof throttle to the generic invalid-code
 * rejection, for use at every ANONYMOUS verification boundary.
 *
 * Returns the error unchanged when it is not one, so a call site can hand it
 * whatever it caught. Authenticated boundaries deliberately do NOT call this —
 * there is no account to reveal to a caller who already holds its session, and
 * the accurate `Retry-After` is worth more there.
 */
export function collapseProofThrottle(
  error: unknown,
  genericMessage: string
): unknown {
  if (error instanceof CustomError && error.code === OTP_PROOF_THROTTLE_CODE)
    return new CustomError(genericMessage, HTTP_STATUS.BAD_REQUEST);
  return error;
}

/**
 * Statuses an anonymous verify route never collapses: 429 keeps its headers,
 * 503 surfaces so a fail-closed limiter outage is not masked as a wrong code,
 * and 500/422 pass through. None depends on whether the account exists.
 */
const ANONYMOUS_VERIFY_SURFACED: ReadonlySet<number> = new Set([
  HTTP_STATUS.TOO_MANY_REQUESTS,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.INTERNAL_ERROR,
  HTTP_STATUS.UNPROCESSABLE,
]);

/**
 * The status filter at an anonymous verification boundary: unknown user, wrong
 * code and missing proof answer one generic 400. The proof throttle collapses
 * BEFORE the filter, so only the pre-lookup limiters keep a 429. `alsoSurface`
 * is for a refusal only a CORRECT code can reach.
 */
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

/** The one refusal an anonymous OTP surface gives for every account-revealing failure. */
export function invalidOrExpiredCode(): CustomError {
  return new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);
}
