import { runDatabaseSweep } from '@/lib/maintenance/database';
import { runMaintenanceSweep } from '@/lib/maintenance/sqlite';
import { reconcileObjectStore } from '@/lib/media/reconcile';
import { hasUsageSources } from '@/lib/media/usages';

import { errorClassOf, logLine } from '@/utils/log';

// Infrastructure schedules must not move with host or business time zones.
const SCHEDULE_TIMEZONE = 'UTC';

interface SweepOutcome {
  status: 'ok' | 'degraded';
  hasMore: boolean;
  durationMs: number;
}

interface ScheduledJob {
  readonly name: string;
  readonly expression: string;
  readonly run: () => Promise<SweepOutcome>;
}

const JOBS: readonly ScheduledJob[] = [
  {
    name: 'sqlite-expiry-sweep',
    expression: '*/15 * * * *',
    run: runMaintenanceSweep,
  },
  {
    name: 'database-retention-sweep',
    expression: '30 3 * * *',
    run: runDatabaseSweep,
  },
  // Read-only and weekly, because it pages the whole bucket. The report is
  // what a human acts on; nothing here deletes.
  {
    name: 'object-store-reconcile',
    expression: '0 4 * * 0',
    run: async () => {
      const report = await reconcileObjectStore();
      logLine('log', { msg: 'object store reconciled', ...report });
      return {
        status: 'ok',
        // A cut-short listing or an exhausted HEAD budget left rows uncompared.
        hasMore: report.buckets.some(
          (bucket) => bucket.truncated || bucket.unchecked > 0
        ),
        durationMs: report.durationMs,
      };
    },
  },
];

function logRun(name: string, outcome: SweepOutcome): void {
  // A degraded run is a FAILURE event: it returned, but a store it was asked
  // to sweep was not swept.
  const degraded = outcome.status === 'degraded';
  logLine(degraded ? 'error' : 'log', {
    msg: degraded ? 'scheduled sweep degraded' : 'scheduled sweep completed',
    job: name,
    status: outcome.status,
    durationMs: outcome.durationMs,
    hasMore: outcome.hasMore,
  });
}

function logFailure(name: string, error: unknown): void {
  logLine('error', {
    msg: 'scheduled sweep failed',
    job: name,
    errorClass: errorClassOf(error),
  });
}

interface ScheduleHandle {
  /**
   * Prevents further firings AND waits up to `timeoutMs` for a callback
   * already running; `true` when nothing is still in flight. Stopping the cron
   * alone would let shutdown close the stores under a sweep that is between
   * batches.
   */
  stopAndDrain: (timeoutMs: number) => Promise<boolean>;
}

/**
 * Registration stays explicit so importing application modules cannot start
 * timers.
 *
 * ⚠️ Every job is registered in EVERY process that calls this, and none is
 * safe to run twice concurrently. The single owner is elected by
 * `acquireWriterLock(SQLITE_DIR)` in `server.ts`, which runs first and fails a
 * second instance's startup; a change to either has to account for the other.
 *
 * `jobs` is a parameter only for `tests/process/schedule-drain.test.ts`.
 */
export function startSchedule(
  jobs: readonly ScheduledJob[] = JOBS
): ScheduleHandle {
  // `Bun.cron` never overlaps a job with ITSELF, but says nothing about a
  // callback still running when the process is asked to stop.
  const inFlight = new Set<Promise<void>>();

  const handles = jobs.map((job) =>
    Bun.cron(
      job.expression,
      () => {
        const run = (async () => {
          try {
            logRun(job.name, await job.run());
          } catch (error) {
            logFailure(job.name, error);
          }
        })();
        inFlight.add(run);
        // Returning `run` is what keeps the no-overlap guarantee: `Bun.cron`
        // awaits it.
        return run.finally(() => inFlight.delete(run));
      },
      { tz: SCHEDULE_TIMEZONE }
    )
  );

  // With no `USAGE_SOURCES` declared, the unfiled half of the retention sweep
  // can neither list nor reap anything; said once so a project built on this
  // kit does not inherit that silently.
  if (!hasUsageSources())
    logLine('log', {
      msg: 'media.usage-registry is empty',
      detail:
        'No owner table is declared in lib/media/usages.ts, so the media API governs library files only and the unfiled scope and its reaper are inert.',
    });

  logLine('log', {
    msg: 'maintenance schedule started',
    timezone: SCHEDULE_TIMEZONE,
    jobs: jobs.map((job) => ({
      name: job.name,
      expression: job.expression,
      nextRun:
        Bun.cron
          .parse(job.expression, undefined, { tz: SCHEDULE_TIMEZONE })
          ?.toISOString() ?? null,
    })),
  });

  return {
    stopAndDrain: async (timeoutMs: number) => {
      for (const handle of handles) handle.stop();
      if (inFlight.size === 0) return true;

      logLine('log', {
        msg: 'waiting for in-flight sweep',
        jobs: inFlight.size,
      });
      const timedOut = Symbol('sweep-drain-timeout');
      const raced = await Promise.race([
        // Each run already contains its own failure; a rejection must not
        // abandon the drain.
        Promise.all(inFlight).catch(() => {}),
        Bun.sleep(timeoutMs).then(() => timedOut),
      ]);
      if (raced === timedOut)
        logLine('error', {
          msg: 'sweep drain timed out',
          jobs: inFlight.size,
          timeoutMs,
        });
      return inFlight.size === 0;
    },
  };
}
