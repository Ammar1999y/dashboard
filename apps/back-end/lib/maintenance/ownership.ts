import type { ScheduleHandle } from '@/lib/maintenance/schedule';
import type { WriterLock } from '@/lib/sqlite/writer-lock';

import { startSchedule } from '@/lib/maintenance/schedule';

import { errorClassOf, logLine } from '@/utils/log';

/** `Bun.cron`'s own granularity: an earlier claim could not run a job sooner. */
const CLAIM_RETRY_MS = 60_000;

interface ScheduleOwnership extends ScheduleHandle {
  /** Gives up the directory; a no-op when this process never owned it. */
  release: () => void;
}

/**
 * Starts the schedule now when `claimed` holds the SQLite directory, or once a
 * retried `claim` wins it: the owner can exit first (a crash, or the old
 * release of an overlapping deploy), and a loser that never retried would leave
 * the survivors with no sweeps at all.
 *
 * The first claim is the caller's, so a broken directory fails the boot before
 * the port is bound; one that throws on a retry is logged and retried.
 */
export function scheduleWhenOwner(
  claimed: WriterLock | null,
  claim: () => WriterLock | null,
  options: { start?: () => ScheduleHandle; retryMs?: number } = {}
): ScheduleOwnership {
  const start = options.start ?? startSchedule;
  const state: {
    lock: WriterLock | null;
    schedule: ScheduleHandle | null;
    retry: ReturnType<typeof setInterval> | null;
  } = { lock: claimed, schedule: null, retry: null };

  if (state.lock) state.schedule = start();
  else {
    logLine('log', {
      msg: 'maintenance schedule not started',
      reason: 'another process owns SQLITE_DIR',
    });
    state.retry = setInterval(() => {
      try {
        state.lock = claim();
      } catch (error) {
        logLine('error', {
          msg: 'writer lock claim failed',
          errorClass: errorClassOf(error),
        });
        return;
      }
      if (!state.lock) return;
      stopRetrying();
      state.schedule = start();
    }, options.retryMs ?? CLAIM_RETRY_MS);
  }

  function stopRetrying(): void {
    if (state.retry) clearInterval(state.retry);
    state.retry = null;
  }

  return {
    stopAndDrain: (timeoutMs) => {
      stopRetrying();
      return state.schedule
        ? state.schedule.stopAndDrain(timeoutMs)
        : Promise.resolve(true);
    },
    release: () => state.lock?.release(),
  };
}
