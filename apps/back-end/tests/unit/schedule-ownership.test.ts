import { describe, expect, test } from 'bun:test';
import type { ScheduleHandle } from '@/lib/maintenance/schedule';
import type { WriterLock } from '@/lib/sqlite/writer-lock';

import { scheduleWhenOwner } from '@/lib/maintenance/ownership';

const RETRY_MS = 20;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(RETRY_MS);
}

function fakes(outcomes: (boolean | Error)[]) {
  const calls = { claims: 0, starts: 0, releases: 0, drains: 0 };
  const lock: WriterLock = {
    release: () => {
      calls.releases += 1;
    },
  };
  const claim = () => {
    const outcome = outcomes[Math.min(calls.claims, outcomes.length - 1)];
    calls.claims += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome ? lock : null;
  };
  const start = (): ScheduleHandle => {
    calls.starts += 1;
    return {
      stopAndDrain: () => {
        calls.drains += 1;
        return Promise.resolve(true);
      },
    };
  };
  return { calls, claim, start };
}

describe('scheduleWhenOwner', () => {
  test('the owner starts the schedule at once and releases on stop', async () => {
    const { calls, claim, start } = fakes([true]);
    const ownership = scheduleWhenOwner(claim(), claim, {
      start,
      retryMs: RETRY_MS,
    });

    expect(calls.starts).toBe(1);
    expect(await ownership.stopAndDrain(100)).toBe(true);
    ownership.release();
    expect(calls).toEqual({ claims: 1, starts: 1, releases: 1, drains: 1 });
  });

  test('a loser starts nothing until the directory frees up, then takes over', async () => {
    const { calls, claim, start } = fakes([false, false, true]);
    const ownership = scheduleWhenOwner(claim(), claim, {
      start,
      retryMs: RETRY_MS,
    });

    expect(calls.starts).toBe(0);
    await until(() => calls.starts > 0);

    expect(calls.claims).toBe(3);
    expect(calls.starts).toBe(1);
    await ownership.stopAndDrain(100);
    ownership.release();
    expect(calls.releases).toBe(1);
  });

  test('stopping before a takeover ends the retries and holds nothing', async () => {
    const { calls, claim, start } = fakes([false]);
    const ownership = scheduleWhenOwner(claim(), claim, {
      start,
      retryMs: RETRY_MS,
    });

    expect(await ownership.stopAndDrain(100)).toBe(true);
    const claimsAtStop = calls.claims;
    await Bun.sleep(RETRY_MS * 4);
    ownership.release();

    expect(calls.claims).toBe(claimsAtStop);
    expect(calls).toMatchObject({ starts: 0, releases: 0, drains: 0 });
  });

  test('a claim that throws on a retry is retried, not escaped', async () => {
    const { calls, claim, start } = fakes([false, new Error('busy'), true]);
    const ownership = scheduleWhenOwner(claim(), claim, {
      start,
      retryMs: RETRY_MS,
    });

    await until(() => calls.starts > 0);

    expect(calls.starts).toBe(1);
    await ownership.stopAndDrain(100);
  });
});
