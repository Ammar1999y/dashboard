import {
  runDatabaseSweep,
  runVerificationSweep,
} from '@/lib/maintenance/database';
import { runElected } from '@/lib/maintenance/election';
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
  /**
   * Acts on PostgreSQL or R2, which every container shares, so each firing
   * runs only where it wins `runElected`.
   */
  readonly shared: boolean;
  /**
   * `stopping` aborts at shutdown: the run ends at its next batch or R2 call
   * and leaves the rest to the next firing.
   */
  readonly run: (stopping: AbortSignal) => Promise<SweepOutcome>;
}

const JOBS: readonly ScheduledJob[] = [
  {
    name: 'sqlite-expiry-sweep',
    expression: '*/15 * * * *',
    shared: false,
    run: (stopping) => runMaintenanceSweep(Date.now(), stopping),
  },
  {
    name: 'verification-expiry-sweep',
    expression: '*/15 * * * *',
    shared: true,
    run: (stopping) => runVerificationSweep(Date.now(), stopping),
  },
  {
    name: 'database-retention-sweep',
    expression: '30 3 * * *',
    shared: true,
    run: (stopping) => runDatabaseSweep(Date.now(), stopping),
  },
  // Read-only and weekly, because it pages the whole bucket. The report is
  // what a human acts on; nothing here deletes.
  {
    name: 'object-store-reconcile',
    expression: '0 4 * * 0',
    shared: true,
    run: async (stopping) => {
      const report = await reconcileObjectStore(Date.now(), stopping);
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

function logSkipped(name: string): void {
  logLine('log', {
    msg: 'scheduled sweep skipped',
    job: name,
    reason: 'running in another instance',
  });
}

function logFailure(name: string, error: unknown, stopping: AbortSignal): void {
  // The shutdown's own abort, surfacing from a connection wait or an R2 call
  // the run did not catch: the stop it asked for, not a failure.
  if (stopping.aborted && errorClassOf(error) === 'AbortError') {
    logLine('log', {
      msg: 'scheduled sweep cancelled',
      job: name,
      reason: 'shutting down',
    });
    return;
  }
  logLine('error', {
    msg: 'scheduled sweep failed',
    job: name,
    errorClass: errorClassOf(error),
  });
}

export interface ScheduleHandle {
  /**
   * Synchronous: no firing starts once it returns, and a running one is asked
   * to stop. Shutdown calls it before draining requests, which can take
   * minutes, so a cron boundary inside that drain starts nothing.
   */
  halt: () => void;
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
 * ⚠️ Started only in the process that owns `SQLITE_DIR` (`scheduleWhenOwner`),
 * and a `shared` job is elected again per firing, because containers on
 * separate volumes each own theirs. Measured running twice at once: the
 * PostgreSQL deletes removed each row once, but the orphaned-object sweep
 * repeated its R2 deletes and over-reported `removed`.
 *
 * `jobs` is a parameter only for `tests/process/schedule-drain.test.ts`.
 */
export function startSchedule(
  jobs: readonly ScheduledJob[] = JOBS
): ScheduleHandle {
  // `Bun.cron` never overlaps a job with ITSELF, but says nothing about a
  // callback still running when the process is asked to stop.
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();

  const handles = jobs.map((job) =>
    Bun.cron(
      job.expression,
      () => {
        const run = (async () => {
          try {
            if (!job.shared) {
              logRun(job.name, await job.run(stopping.signal));
              return;
            }
            const election = await runElected(
              job.name,
              () => job.run(stopping.signal),
              stopping.signal
            );
            if (election.elected) logRun(job.name, election.result);
            else logSkipped(job.name);
          } catch (error) {
            logFailure(job.name, error, stopping.signal);
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
      shared: job.shared,
      nextRun:
        Bun.cron
          .parse(job.expression, undefined, { tz: SCHEDULE_TIMEZONE })
          ?.toISOString() ?? null,
    })),
  });

  // Also aborts a firing still waiting for its lock connection, which must not
  // start a whole sweep after shutdown began.
  const halt = () => {
    for (const handle of handles) handle.stop();
    stopping.abort();
  };

  return {
    halt,
    stopAndDrain: async (timeoutMs: number) => {
      halt();
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
