import { errorClassOf } from '@/utils/log';

/**
 * `server.ts` applies these, the startup log reports them, and
 * `tests/unit/shutdown-coordinator.test.ts` checks the runbook's copy against
 * them.
 */
export const SHUTDOWN_POLICY = {
  /** Added on top of the longest request ceiling; the orchestrator's grace must exceed the total. */
  headroomSeconds: 15,
  /** How long `server.stop()` may wait on half-sent connections before `server.stop(true)`. */
  gracefulStopMs: 5000,
} as const;

export function shutdownTimeoutMs(input: {
  idleTimeoutSeconds: number;
  maxRouteTimeoutSeconds: number;
}): number {
  return (
    (Math.max(input.idleTimeoutSeconds, input.maxRouteTimeoutSeconds) +
      SHUTDOWN_POLICY.headroomSeconds) *
    1000
  );
}

interface GracefulStopDeps {
  /** `Bun.Server.stop`; `true` closes active connections. */
  stop: (closeActiveConnections?: boolean) => Promise<unknown>;
  /** Bun's in-flight request count — `Server.pendingRequests`. */
  pendingRequests: () => number;
  /** How long this phase may take before the shutdown deadline is reached. */
  budgetMs: number;
  error: (line: Record<string, unknown>) => void;
  graceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The listener half of `GracefulStopDeps`, taken from Bun's server and not from
 * `app.stop`/`app.server`: Elysia 2 clears `app.server` as soon as a stop
 * begins, so the in-flight count would read 0 and no request would buy more
 * grace, and its own drain would race the escalation below.
 */
export function listenerStopDeps(server: {
  stop: (closeActiveConnections?: boolean) => Promise<unknown>;
  readonly pendingRequests: number;
}): Pick<GracefulStopDeps, 'stop' | 'pendingRequests'> {
  return {
    stop: (closeActiveConnections) => server.stop(closeActiveConnections),
    pendingRequests: () => server.pendingRequests,
  };
}

/**
 * Stop the listener, waiting for real work and force-closing only what is not.
 *
 * `server.stop()` alone can hang forever on a HALF-SENT request (headers, no
 * body), so it escalates to `server.stop(true)`. A fixed grace cannot tell that
 * connection from a slow upload, so `pendingRequests` decides: a request in
 * flight buys another grace interval, up to the caller's budget; nothing in
 * flight escalates at once.
 *
 * Never throws for slowness. Only a rejection from `stop` itself propagates:
 * the listener's own teardown faulted, which is not a clean exit.
 */
export async function stopServerGracefully(
  deps: GracefulStopDeps
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  const graceMs = deps.graceMs ?? SHUTDOWN_POLICY.gracefulStopMs;
  const deadline = now() + deps.budgetMs;

  // Settled through a state object rather than by racing the raw promise: the
  // same promise is raced once per interval, and a rejection observed by no
  // race — because an earlier interval force-closed and returned — is an
  // unhandled rejection.
  const state: { done: boolean; failure: unknown } = {
    done: false,
    failure: null,
  };
  const graceful = deps
    .stop()
    .then(() => {
      state.done = true;
    })
    .catch((error: unknown) => {
      state.done = true;
      state.failure = error ?? new Error('server stop rejected');
    });

  for (;;) {
    const timedOut = Symbol('graceful-stop-timeout');
    // Clamped to what is LEFT, not the full interval: an unclamped wait can
    // outlive the caller's deadline by a whole interval, and the forced-exit
    // timer then fires while this is still draining.
    const waitMs = Math.min(graceMs, Math.max(0, deadline - now()));
    const outcome = await Promise.race([
      graceful,
      sleep(waitMs).then(() => timedOut),
    ]);
    if (outcome !== timedOut) {
      if (state.failure !== null) throw state.failure;
      return;
    }

    const pendingRequests = deps.pendingRequests();
    const remainingMs = deadline - now();
    if (pendingRequests > 0 && remainingMs > 0) {
      deps.error({
        msg: 'graceful stop still draining in-flight requests',
        pendingRequests,
        remainingMs,
      });
      continue;
    }

    deps.error({
      msg: 'graceful stop timed out, closing active connections',
      graceMs,
      pendingRequests,
      budgetExhausted: remainingMs <= 0,
    });
    await deps.stop(true);
    return;
  }
}

interface ShutdownDeps {
  /**
   * Stops accepting requests and drains or closes the ones in flight, within
   * the shutdown budget still unspent when it is called.
   */
  stopServer: (budgetMs: number) => Promise<void>;
  /** Prevents further sweep firings and waits for a running one; true when idle. */
  stopSweeps: (timeoutMs: number) => Promise<boolean>;
  /** Waits for queued post-response work; true when the queue is observably empty. */
  drainAfterResponse: (timeoutMs: number) => Promise<boolean>;
  pendingAfterResponse: () => number;
  /** Attempts every store and rejects if any failed to close. */
  closeStores: () => Promise<void>;
  exit: (code: number) => void;
  log: (line: Record<string, unknown>) => void;
  error: (line: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * The shutdown coordinator, with its dependencies injected so the sequence can
 * be driven in a test without a socket or a signal.
 *
 * The contract: the stop is clean only when both drains have POSITIVELY
 * reported quiescence and the stores have closed before the forced-exit
 * deadline; anything unproven at the deadline is reported and exits 1. The
 * proof is the drain's own (the after-response queue must observe itself empty
 * for `AFTER_RESPONSE_SETTLE_MS`), so work ending inside that last interval is
 * still a forced exit. Neither drain cancels what it waits for, so the stores
 * are closed ONLY on that proof. The drains share the whole budget, not fixed
 * slices: a slice sized from a nominal duration fails deploys whose work merely
 * ran long. A phase that faulted is never an exit 0.
 *
 * A fault arriving mid-shutdown cannot restart the sequence, but the highest
 * exit code any call asked for, or any phase failure raised, is the one the
 * process ends with.
 */
export function createShutdown(
  deps: ShutdownDeps,
  timeouts: { shutdownMs: number }
): (signal: string, exitCode?: number) => Promise<void> {
  const now = deps.now ?? Date.now;
  const state = { started: false, exitCode: 0 };

  return async function shutdown(signal, exitCode = 0) {
    state.exitCode = Math.max(state.exitCode, exitCode);
    if (state.started) {
      deps.log({ msg: 'shutdown already in progress', signal, exitCode });
      return;
    }
    state.started = true;
    const startedAt = now();
    const deadline = startedAt + timeouts.shutdownMs;

    deps.log({ msg: 'server stopping', signal });

    // Once, from whichever path gets there first: the timer, or the sequence
    // itself when a synchronous step held the loop past the deadline and the
    // timer could not preempt it.
    const forcedState = { done: false };
    const forceExit = () => {
      if (forcedState.done) return;
      forcedState.done = true;
      clearTimeout(forced);
      deps.error({
        msg: 'forced shutdown',
        signal,
        pendingAfterResponse: deps.pendingAfterResponse(),
      });
      deps.exit(1);
    };
    const forced = setTimeout(forceExit, timeouts.shutdownMs);

    const remaining = () => Math.max(0, deadline - now());
    const overdue = () => now() >= deadline;

    const quiesced = { sweeps: false, afterResponse: false };

    // Its own boundary: a faulted stop must not skip the drains, or the guard
    // below holds the stores open with nothing in flight until the forced exit.
    // Continuing is safe because `Bun.Server.stop()` closes the listening
    // socket when CALLED, so a later rejection never means the listener is
    // still admitting requests; the exit code still records the fault.
    try {
      await deps.stopServer(remaining());
    } catch (error) {
      state.exitCode = Math.max(state.exitCode, 1);
      deps.error({
        msg: 'server stop failed',
        errorClass: errorClassOf(error),
      });
    }

    try {
      quiesced.sweeps = await deps.stopSweeps(remaining());
      quiesced.afterResponse = await deps.drainAfterResponse(remaining());
      if (!quiesced.afterResponse)
        deps.error({
          msg: 'after-response drain timed out',
          pendingAfterResponse: deps.pendingAfterResponse(),
        });
    } catch (error) {
      deps.error({ msg: 'shutdown error', errorClass: errorClassOf(error) });
    }

    if (!quiesced.sweeps || !quiesced.afterResponse || overdue()) {
      deps.error({
        msg: 'stores left open for forced exit',
        signal,
        sweepsDrained: quiesced.sweeps,
        afterResponseDrained: quiesced.afterResponse,
        pendingAfterResponse: deps.pendingAfterResponse(),
        forcedInMs: remaining(),
      });
      if (overdue()) forceExit();
      return;
    }

    // `closeStores` attempts every store and reports the ones that failed; an
    // unclosed store is not the clean exit this contract promises.
    try {
      await deps.closeStores();
    } catch (error) {
      state.exitCode = Math.max(state.exitCode, 1);
      deps.error({
        msg: 'stores did not close cleanly',
        errorClass: errorClassOf(error),
      });
    }

    // The contract is "closed BEFORE the deadline"; a close that finished after
    // it is reported as the bound it exceeded, not as a clean stop.
    if (overdue()) {
      forceExit();
      return;
    }

    clearTimeout(forced);
    deps.log({ msg: 'server stopped', signal, exitCode: state.exitCode });
    deps.exit(state.exitCode);
  };
}
