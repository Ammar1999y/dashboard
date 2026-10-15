/**
 * Ends a process whose application pool has wedged, which only a restart
 * clears. Readiness reports the wedge, but Coolify only takes an unhealthy
 * container out of routing; its restart policy restarts one that exits.
 */
export interface PoolWatchdog {
  usable: () => Promise<boolean>;
  onWedged: () => void;
  intervalMs: number;
  /** The second look: a pool that recovers from a dropped connection does so well within it. */
  confirmMs: number;
}

/** Starts the checks; answers the function that stops them. */
export function watchApplicationPool(watch: PoolWatchdog): () => void {
  const state = { stopped: false, checking: false };
  const check = async () => {
    if (state.checking) return;
    state.checking = true;
    try {
      if (await watch.usable()) return;
      await Bun.sleep(watch.confirmMs);
      if (!state.stopped && !(await watch.usable())) watch.onWedged();
    } finally {
      state.checking = false;
    }
  };
  const timer = setInterval(() => void check(), watch.intervalMs);
  timer.unref();
  return () => {
    state.stopped = true;
    clearInterval(timer);
  };
}
