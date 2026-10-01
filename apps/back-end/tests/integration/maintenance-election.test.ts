/**
 * `runElected` against the real pool: each elector reserves its own
 * connection, so these are separate PostgreSQL sessions, which is what two
 * containers are.
 */
import { describe, expect, test } from 'bun:test';

import { runElected } from '@/lib/maintenance/election';

describe('the scheduled-job election', () => {
  test('concurrent electors of one job yield exactly one runner', async () => {
    const ELECTORS = 4;
    const gate = Promise.withResolvers<void>();
    const runs: number[] = [];
    let settled = 0;

    const electors = Array.from({ length: ELECTORS }, (_, index) =>
      runElected('election-probe', async () => {
        runs.push(index);
        // Held until every other elector has been answered, so none of them
        // can win merely by arriving after the winner finished.
        await gate.promise;
        return index;
      }).finally(() => {
        settled += 1;
        if (settled === ELECTORS - 1) gate.resolve();
      })
    );

    const outcomes = await Promise.all(electors);

    expect(runs).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.elected)).toEqual(
      runs.map((index) => ({ elected: true, result: index }))
    );
  });

  test('the lock is released after a run, including one that throws', async () => {
    await expect(
      runElected('election-release', () =>
        Promise.reject(new Error('sweep exploded'))
      )
    ).rejects.toThrow('sweep exploded');

    expect(await runElected('election-release', async () => 'next')).toEqual({
      elected: true,
      result: 'next',
    });
  });

  test('different jobs do not block each other', async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const holding = runElected('election-a', async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    const other = await runElected('election-b', async () => 'ran');
    gate.resolve();
    await holding;

    expect(other).toEqual({ elected: true, result: 'ran' });
  });

  test('an aborted signal gives up before taking a connection, and the job does not run', async () => {
    const stopping = new AbortController();
    stopping.abort();
    let ran = false;

    await expect(
      runElected(
        'election-abort',
        async () => {
          ran = true;
        },
        stopping.signal
      )
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });
});
