/**
 * Subprocess body for `schedule-drain.test.ts`.
 *
 * Registers ONE job on the real `startSchedule`, waits for `Bun.cron` to fire it
 * for real, and then stops the schedule while that callback is still running —
 * which is the only window `stopAndDrain` exists for and the only way to reach
 * it. Emits one JSON line per event so the parent asserts on ORDER, not on
 * timing.
 *
 * `argv[2]` picks which branch is exercised: `drain` gives the job less time
 * than the deadline, `timeout` gives it more, `elected` registers the job
 * twice as `shared`, so both firings contend for its PostgreSQL lock, and
 * `throws` fails the first firing and drains during the second, a minute later.
 */
/* eslint-disable unicorn/no-process-exit -- this fixture IS a process entry
   point: its stdout and exit code are the assertion. */
import { startSchedule } from '@/lib/maintenance/schedule';

const MODES = ['drain', 'timeout', 'elected', 'throws'] as const;
const mode =
  MODES.find((candidate) => candidate === process.argv[2]) ?? 'drain';
const JOB_MS = { drain: 300, timeout: 5000, elected: 3000, throws: 300 }[mode];
const DRAIN_MS = { drain: 5000, timeout: 300, elected: 10_000, throws: 5000 }[
  mode
];

class ProbeSweepError extends Error {
  override name = 'ProbeSweepError';
}

function emit(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...extra }));
}

const started = Promise.withResolvers<void>();
const firings = { count: 0 };

const probe = {
  name: 'drain-probe',
  expression: '* * * * *',
  shared: mode === 'elected',
  run: async () => {
    firings.count += 1;
    emit('probe started');
    if (mode === 'throws' && firings.count === 1)
      throw new ProbeSweepError('probe sweep failed');
    started.resolve();
    await Bun.sleep(JOB_MS);
    emit('probe finished');
    return { status: 'ok' as const, hasMore: false, durationMs: JOB_MS };
  },
};

const schedule = startSchedule(mode === 'elected' ? [probe, probe] : [probe]);

// Up to one minute, two for `throws`: `Bun.cron` fires on the next boundary
// and offers no way to trigger a job by hand.
await started.promise;
// The losing firing is still being answered when the winner starts; draining
// now would abort its wait for a connection instead of letting it lose.
if (mode === 'elected') await Bun.sleep(1000);

const drained = await schedule.stopAndDrain(DRAIN_MS);
emit('drain returned', { mode, drained });

// The BRANCH is what mirrors `server.ts`, not just the order. A store closed
// while a sweep is mid-batch is what the drain exists to prevent, so the
// coordinator closes stores only on positive proof that nothing is in flight —
// and on a timed-out drain it logs `stores left open for forced exit` and
// returns WITHOUT closing them. Emitting `stores closed` unconditionally here
// pinned the sequence that behaviour replaced, so the one test naming the
// timed-out drain asserted the opposite of what ships.
emit(drained ? 'stores closed' : 'stores left open for forced exit');
process.exit(0);
