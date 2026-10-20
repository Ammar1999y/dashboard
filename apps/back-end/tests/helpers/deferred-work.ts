/**
 * Waiting for post-response work inside a test run: the preload's hooks and
 * `settleDelivery`. Imports only `lib/http/after-response`, which reads no
 * environment, so the preload may load it.
 */
import {
  drainAfterResponse,
  enqueuedAfterResponse,
  pendingAfterResponse,
} from '@/lib/http/after-response';

export const DEFERRED_WORK_DRAIN_MS = 5000;

/**
 * The budget while earlier work is known to be stranded: enough for a later
 * test's own work, and for the stranded work if it is merely late, without
 * every later hook spending the full budget on work that never settles.
 */
const STRANDED_DRAIN_MS = 500;

const state = {
  /** `enqueuedAfterResponse()` when a drain last proved the queue idle. */
  idleAt: -1,
  /**
   * A drain spent its full budget and work was still running. Under
   * `--no-isolate` that work outlives the test that stranded it.
   */
  stranded: false,
};

/**
 * Settles queued post-response work or throws, failing the test that asked.
 * The caller must not reset shared mocks after a throw: the unsettled work
 * would write into the next test's fresh state.
 *
 * With nothing enqueued since the last drain that proved the queue idle it
 * returns at once, sparing a test that deferred no work the drain's settle
 * period. Work enqueued after that check is the next call's to find, so the
 * last call of a file passes `always`.
 */
export async function settleDeferredWork(
  when: 'unless-idle' | 'always' = 'unless-idle'
): Promise<void> {
  const enqueued = enqueuedAfterResponse();
  const idle = pendingAfterResponse() === 0;
  // Nothing in flight: whatever was stranded has settled since.
  if (idle) state.stranded = false;
  if (when === 'unless-idle' && idle && enqueued === state.idleAt) return;

  const budget = state.stranded ? STRANDED_DRAIN_MS : DEFERRED_WORK_DRAIN_MS;
  if (await drainAfterResponse(budget)) {
    state.idleAt = enqueued;
    state.stranded = false;
    return;
  }
  state.stranded = true;
  throw new Error(
    `post-response work did not settle within ${budget} ms: ${pendingAfterResponse()} batch(es) still running, so the shared mocks are left unreset.`
  );
}
