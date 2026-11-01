/**
 * The process-wide password slot (`lib/auth/password/hash.ts`): one Argon2 job
 * at a time, a bounded queue, and a refusal that reaches the caller as a 503
 * rather than as a wrong password.
 */
import { expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';

import {
  hashPassword,
  PASSWORD_WORK_QUEUE,
  verifyPasswordDetailed,
  withPasswordSlot,
} from '@/lib/auth/password/hash';

const PASSWORD = 'Harness!Sl0tPass';

/** Holds the slot and fills its queue until the returned release runs. */
function saturate(): () => Promise<void> {
  const gate = Promise.withResolvers<void>();
  const holders = Array.from({ length: 1 + PASSWORD_WORK_QUEUE }, () =>
    withPasswordSlot(() => gate.promise)
  );
  return async () => {
    gate.resolve();
    await Promise.allSettled(holders);
  };
}

test('a hash or verify nested in a held slot reuses it instead of queueing', async () => {
  const hash = await withPasswordSlot(async () => {
    const stored = await hashPassword(PASSWORD);
    const verdict = await verifyPasswordDetailed({
      hash: stored,
      password: PASSWORD,
    });
    expect(verdict.valid).toBe(true);
    return stored;
  });
  expect(hash.startsWith('p1:')).toBe(true);
});

test('past a full queue, a verify is refused with 503 and Retry-After, not answered as a wrong password', async () => {
  const stored = await hashPassword(PASSWORD);
  const release = saturate();
  try {
    await expect(
      verifyPasswordDetailed({ hash: stored, password: PASSWORD })
    ).rejects.toMatchObject({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      responseHeaders: { 'Retry-After': '2' },
    });
    await expect(hashPassword(PASSWORD)).rejects.toMatchObject({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    });
  } finally {
    await release();
  }

  // Every slot and queue place came back.
  const verdict = await verifyPasswordDetailed({
    hash: stored,
    password: PASSWORD,
  });
  expect(verdict.valid).toBe(true);
});

test('hashes run one at a time across concurrent callers', async () => {
  let active = 0;
  let peak = 0;
  const tracked = () =>
    withPasswordSlot(async () => {
      active++;
      peak = Math.max(peak, active);
      await hashPassword(PASSWORD);
      active--;
    });
  // Outside any slot each call queues; inside one, `active` would exceed 1.
  await Promise.all([tracked(), tracked(), tracked()]);
  expect(peak).toBe(1);
});
