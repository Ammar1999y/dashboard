import type { Handler, HandlerInput, HandlerOutput } from './contract';

import { handleApiError } from './response';

// Anonymous OTP handlers use this floor to reduce lookup/proof timing signals.
// Provider delivery is deferred on anonymous send paths and is not part of it.
// TODO: Measure the real `processOtpSend` latency distribution and tune this value if needed.
const MINIMUM_RESPONSE_MS = 1500;

export async function ensureMinDelay(elapsed: number): Promise<void> {
  if (elapsed < MINIMUM_RESPONSE_MS)
    await new Promise((r) => setTimeout(r, MINIMUM_RESPONSE_MS - elapsed));
}

/** Pads the response to the floor, measured from when the handler started. */
type TimingFloor = () => Promise<void>;

/**
 * `withApiErrors` for the anonymous surfaces: every thrown refusal waits out
 * the floor before it is mapped, so a fast failure cannot be told from a slow
 * success. A path that must answer without the floor returns instead of
 * throwing; a success path awaits `floor` itself.
 *
 * `rewriteError` rewrites the error before `handleApiError` sees it, which is how
 * a route collapses account-revealing statuses into one generic refusal.
 */
export function withTimingFloor(
  fallbackMessage: string,
  handler: (ctx: HandlerInput, floor: TimingFloor) => Promise<HandlerOutput>,
  rewriteError?: (error: unknown) => unknown
): Handler {
  return async (ctx) => {
    const start = Date.now();
    const floor: TimingFloor = () => ensureMinDelay(Date.now() - start);
    try {
      return await handler(ctx, floor);
    } catch (error) {
      await floor();
      return handleApiError(
        rewriteError ? rewriteError(error) : error,
        fallbackMessage
      );
    }
  };
}
