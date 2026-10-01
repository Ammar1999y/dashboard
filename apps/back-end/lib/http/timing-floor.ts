import type { Handler, HandlerInput, HandlerOutput } from './contract';

import { BUSY_TIMEOUT_MS } from '@/lib/sqlite/database';

import { handleApiError } from './response';

/**
 * What a known account's branch does besides its one SQLite write (the global
 * send budget), which may wait out the whole busy timeout. Headroom for the
 * uncontended case, not a bound: contention is cut off at `floorDeadline`.
 * Measured in `otp-timing-oracle.test.ts`.
 *
 * TODO: Re-measure on the deployment host; the harness runs PostgreSQL locally,
 * and `FLOOR_SETTLE_MS` assumes a database round trip far below it.
 */
const KNOWN_BRANCH_WORK_MS = 500;

/**
 * Every anonymous OTP outcome that follows the account lookup takes at least
 * this long, counted from the lookup, and no longer: what only a known account
 * reaches is cut off at `floorDeadline`, so a known identifier cannot answer
 * later than an unknown one.
 *
 * - Verify: the transaction as a whole ends at the deadline, however many
 *   statements wait and on whom (`db/transaction.ts` cuts each at the time
 *   left), and is rolled back.
 * - Send: issuance carries on after the response, and every wait in it is
 *   asynchronous, the SQLite charge included. That is what makes the cut-off
 *   hold: it is a timer, a timer cannot run during a synchronous wait, and a
 *   thread blocked there delays every other request too.
 *
 * Provider delivery is deferred on the send paths and is not part of it.
 *
 * Not covered: `/forgot-password/complete`, which only a recovery-grant holder
 * reaches, so no unknown identifier exists to differ from.
 */
export const MINIMUM_RESPONSE_MS = BUSY_TIMEOUT_MS + KNOWN_BRANCH_WORK_MS;

/**
 * Left between the deadline and the floor for the cut-off to be noticed (a
 * rollback, an error mapped to its answer) before the floor is due.
 */
const FLOOR_SETTLE_MS = 250;

/**
 * Epoch ms at which account-dependent work must stop waiting. Send paths answer
 * their generic success at the floor and let the issuance finish after the
 * response. Verify paths answer a refusal, so their work is rolled back and
 * never outlives it (`TransactionDeadlineError`).
 */
export function floorDeadline(startedAt: number): number {
  return startedAt + MINIMUM_RESPONSE_MS - FLOOR_SETTLE_MS;
}

export async function ensureMinDelay(elapsed: number): Promise<void> {
  if (elapsed < MINIMUM_RESPONSE_MS)
    await new Promise((r) => setTimeout(r, MINIMUM_RESPONSE_MS - elapsed));
}

/**
 * Starts the floor's clock and answers its `floorDeadline`. Called where
 * account-dependent work begins: the work before it (limiters, captcha, body,
 * password hashing) is the same for every identifier, so it answers unpadded
 * and spends none of the floor.
 */
export type StartTimingFloor = () => number;

/**
 * `withApiErrors` for the anonymous surfaces: once `startFloor` has run, every
 * outcome, returned or thrown, waits out the floor.
 *
 * `rewriteError` rewrites the error before `handleApiError` sees it, which is how
 * a route collapses account-revealing statuses into one generic refusal.
 */
export function withTimingFloor(
  fallbackMessage: string,
  handler: (
    ctx: HandlerInput,
    startFloor: StartTimingFloor
  ) => Promise<HandlerOutput>,
  rewriteError?: (error: unknown) => unknown
): Handler {
  return async (ctx) => {
    let started: number | undefined;
    const startFloor = () => {
      started ??= Date.now();
      return floorDeadline(started);
    };
    try {
      return await handler(ctx, startFloor);
    } catch (error) {
      return handleApiError(
        rewriteError ? rewriteError(error) : error,
        fallbackMessage
      );
    } finally {
      if (started !== undefined) await ensureMinDelay(Date.now() - started);
    }
  };
}
