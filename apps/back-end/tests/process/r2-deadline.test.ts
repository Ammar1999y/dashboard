/**
 * An R2 call is bounded even when the store sends its headers and then stalls
 * the body. The SDK clears its request timer on the headers and sets no socket
 * timeout, so before the call deadline such a call never settled: the nightly
 * sweep kept its election lock and a pool connection until a restart.
 *
 * The real client runs in a child (`_r2-stall-child.ts`); every tier's preload
 * replaces it. The deadline case waits the whole deadline, about a minute.
 */
import { describe, expect, test } from 'bun:test';

const RUNNER = 'tests/fixtures/_r2-stall-child.ts';

const R2_ENV = {
  R2_ACCOUNT_ID: 'stall-account',
  R2_ACCESS_KEY_ID: 'stall-access-key',
  R2_SECRET_ACCESS_KEY: 'stall-secret-key',
  R2_PRIVATE_BUCKET: 'stall-private',
  PATH: process.env.PATH ?? '',
  ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
};

/** The deadline in `lib/r2/client.ts`: three attempts of 3 s + 15 s. */
const DEADLINE_MS = 54_000;

interface Outcome {
  settled: 'resolved' | 'rejected';
  name?: string;
  ms: number;
}

async function run(mode: 'signal' | 'deadline'): Promise<Outcome> {
  const proc = Bun.spawn(['bun', '--no-env-file', RUNNER, mode], {
    env: R2_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
  return JSON.parse(out.trim().split('\n').at(-1) ?? '') as Outcome;
}

describe('an R2 call whose response body stalls', () => {
  // Spawned together, so the two waits overlap.
  const runs = { signal: run('signal'), deadline: run('deadline') };

  test("the caller's signal ends it, as an abort", async () => {
    const outcome = await runs.signal;
    expect(outcome).toMatchObject({ settled: 'rejected', name: 'AbortError' });
    expect(outcome.ms).toBeLessThan(10_000);
  }, 30_000);

  test(
    'without one, the call deadline ends it, as a timeout',
    async () => {
      const outcome = await runs.deadline;
      expect(outcome).toMatchObject({
        settled: 'rejected',
        name: 'TimeoutError',
      });
      expect(outcome.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
      expect(outcome.ms).toBeLessThan(DEADLINE_MS + 15_000);
    },
    DEADLINE_MS + 30_000
  );
});
