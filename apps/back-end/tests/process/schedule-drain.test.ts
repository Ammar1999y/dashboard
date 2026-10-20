/**
 * `stopAndDrain`, against a sweep that is genuinely running.
 *
 * `shutdown-lifecycle.test.ts` covers the request and store halves of shutdown
 * but never starts the schedule, so the window this guards — SIGTERM arriving
 * mid-sweep — had no test at all. `Bun.cron` guarantees a job never overlaps
 * ITSELF and says nothing about a callback still running when the process is
 * asked to stop; `handle.stop()` only prevents FUTURE firings.
 *
 * Every mode is spawned together so they share the waits for the minute
 * boundary, which are the whole cost of this file: `Bun.cron` has no manual
 * trigger and its finest granularity is one minute. `throws` waits for two.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_schedule-drain-child.ts'
);

interface Outcome {
  exitCode: number | null;
  messages: string[];
  lines: Record<string, unknown>[];
}

/**
 * Notices emitted at MODULE LOAD when a feature is unconfigured, which every
 * assertion below has to look past.
 *
 * They are ordinary correct behaviour for a deployment that does not use the
 * feature — a 404 from a missing configuration is otherwise indistinguishable
 * in an access log from a 404 on an unrouted path, so each is announced once.
 * They are not part of the shutdown sequence this file is about, and the
 * alternative — configuring every feature in this child's environment just to
 * silence them — would make the boot under test less like a real one, not more.
 */
const LOAD_TIME_NOTICES: ReadonlySet<string> = new Set([
  'otp.disabled no channel configured',
  'twoFactor.disabled no method configured',
  // The same class, announced from `startSchedule` because the sweep is what it
  // is about: with no owner table declared, the media library's unfiled scope
  // and its reaper are inert.
  'media.usage-registry is empty',
]);

function runChild(
  mode: 'drain' | 'timeout' | 'elected' | 'throws'
): Promise<Outcome> {
  const child = Bun.spawn(['bun', '--no-env-file', CHILD, mode], {
    cwd: path.join(import.meta.dir, '..', '..'),
    env: { ...process.env, NODE_ENV: 'development' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([out, err, exitCode]) => {
    // Both streams: `sweep drain timed out` is a `console.error`, and it is the
    // whole assertion of the second case. Each stream is ordered on its own, and
    // no message is emitted on both.
    const lines = [out, err]
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    // Filtered on the LINES, not only on the derived messages: the assertions
    // below index this array positionally (`lines.at(-2)`), and a load-time
    // notice arrives on stderr — which this join appends after the whole of
    // stdout — so leaving it in shifts those indices.
    const kept = lines.filter(
      (line) => !LOAD_TIME_NOTICES.has(String(line.msg))
    );
    return {
      exitCode,
      lines: kept,
      messages: kept.map((line) => String(line.msg)),
    };
  });
}

describe('shutdown while a scheduled sweep is running', () => {
  // Started together; each test awaits only its own, so the two-minute
  // `throws` child does not count against the others' timeouts.
  const runs = {
    drain: runChild('drain'),
    timeout: runChild('timeout'),
    elected: runChild('elected'),
    throws: runChild('throws'),
  };

  test('a sweep inside the deadline finishes before the stores close', async () => {
    const outcome = await runs.drain;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.messages).toEqual([
      'maintenance schedule started',
      'probe started',
      'waiting for in-flight sweep',
      'probe finished',
      'scheduled sweep completed',
      'drain returned',
      'stores closed',
    ]);
    expect(outcome.lines.at(-2)).toMatchObject({ drained: true });
  }, 120_000);

  test('a sweep past the deadline is reported rather than waited on forever', async () => {
    const outcome = await runs.timeout;

    expect(outcome.exitCode).toBe(0);
    // The drain gives up and says so. `probe finished` never arrives, which is
    // the loss this reports: shutdown proceeds, it does not hang.
    expect(outcome.messages).toContain('sweep drain timed out');
    // And the stores stay OPEN. A sweep that is still running may still touch
    // one, so `server.ts` hands the process to the forced-exit timer rather than
    // closing underneath it — which is what turned a slow retention sweep into
    // `Statement has finalized`.
    expect(
      outcome.messages.filter((m) => m !== 'sweep drain timed out')
    ).toEqual([
      'maintenance schedule started',
      'probe started',
      'waiting for in-flight sweep',
      'drain returned',
      'stores left open for forced exit',
    ]);
    expect(outcome.messages).not.toContain('stores closed');
    expect(
      outcome.lines.find((line) => line.msg === 'drain returned')
    ).toMatchObject({ drained: false });
  }, 120_000);

  test('a shared job fired twice at once runs once and is skipped once', async () => {
    const outcome = await runs.elected;
    const count = (msg: string) =>
      outcome.messages.filter((m) => m === msg).length;

    expect(outcome.exitCode).toBe(0);
    expect(count('probe started')).toBe(1);
    expect(count('scheduled sweep completed')).toBe(1);
    expect(count('scheduled sweep skipped')).toBe(1);
    expect(outcome.messages).not.toContain('scheduled sweep failed');
    expect(outcome.messages.at(-1)).toBe('stores closed');
  }, 120_000);

  test('a sweep that throws is logged by class, and the next firing still runs', async () => {
    const outcome = await runs.throws;

    expect(outcome.exitCode).toBe(0);
    expect(
      outcome.lines.filter((line) => line.msg === 'scheduled sweep failed')
    ).toEqual([
      {
        msg: 'scheduled sweep failed',
        job: 'drain-probe',
        errorClass: 'ProbeSweepError',
      },
    ]);
    // The second firing is a minute after the first, so it ran only because
    // the failure was contained in the callback that `Bun.cron` awaits.
    expect(
      outcome.messages.filter((m) => m !== 'scheduled sweep failed')
    ).toEqual([
      'maintenance schedule started',
      'probe started',
      'probe started',
      'waiting for in-flight sweep',
      'probe finished',
      'scheduled sweep completed',
      'drain returned',
      'stores closed',
    ]);
  }, 180_000);
});
