import type { HandlerInput, RouteHandler, RouteOutput } from './contract';
import type { ResponseRoute } from '@app/shared/response-contract';

import { BUSY_TIMEOUT_MS } from '@/lib/sqlite/database';

import { handleApiError } from './response';

/**
 * What a known account's branch does besides its one SQLite write (the global
 * send budget), which may wait out the whole busy timeout. Headroom for the
 * uncontended case, not a bound: contention is cut off at `floorDeadline`.
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
 * Padded but not cut off: `/forgot-password/complete`, which only a
 * recovery-grant holder reaches, so no unknown identifier exists to differ from.
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
function floorDeadline(startedAt: number): number {
  return startedAt + MINIMUM_RESPONSE_MS - FLOOR_SETTLE_MS;
}

/**
 * Starts the floor's clock and answers its `floorDeadline`. Called where
 * account-dependent work begins: the work before it (limiters, captcha, body,
 * password hashing) is the same for every identifier, so it answers unpadded
 * and spends none of the floor.
 */
export type StartTimingFloor = () => number;

/**
 * One request's floor: `start` once account-dependent work begins, and
 * `settle` on every way out, which waits out the floor if it started.
 */
export function timingFloor(): {
  start: StartTimingFloor;
  settle: () => Promise<void>;
} {
  let started: number | undefined;
  return {
    start: () => {
      started ??= Date.now();
      return floorDeadline(started);
    },
    settle: async () => {
      if (started === undefined) return;
      const left = MINIMUM_RESPONSE_MS - (Date.now() - started);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    },
  };
}

/**
 * `withApiErrors` for the anonymous surfaces: once `startFloor` has run, every
 * outcome, returned or thrown, waits out the floor.
 *
 * `rewriteError` rewrites the error before `handleApiError` sees it, which is how
 * a route collapses account-revealing statuses into one generic refusal.
 */
export function withTimingFloor<K extends ResponseRoute>(
  key: K,
  fallbackMessage: string,
  handler: (
    ctx: HandlerInput,
    startFloor: StartTimingFloor
  ) => Promise<RouteOutput<K>>,
  rewriteError?: (error: unknown) => unknown
): RouteHandler<K> {
  const floored = async (ctx: HandlerInput): Promise<RouteOutput<K>> => {
    const floor = timingFloor();
    try {
      return await handler(ctx, floor.start);
    } catch (error) {
      return handleApiError(
        rewriteError ? rewriteError(error) : error,
        fallbackMessage
      );
    } finally {
      await floor.settle();
    }
  };
  return Object.assign(floored, { routeKey: key });
}
