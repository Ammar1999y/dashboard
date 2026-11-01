import { expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';
import { uploadMsg } from '@app/shared/messages/media';

import { createAdmission } from '@/lib/admission';
import { processingBusy } from '@/lib/media/errors';

const busy = {
  status: HTTP_STATUS.SERVICE_UNAVAILABLE,
  message: uploadMsg.processingBusy,
};

/** Resolves to whether `promise` settled within a turn of the event loop. */
async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const raced = await Promise.race([promise, Bun.sleep(5).then(() => pending)]);
  return raced !== pending;
}

test('every slot admits at once, then the queue fills, then the busy 503', async () => {
  const acquire = createAdmission({
    slots: 2,
    queueLimit: 1,
    refusal: processingBusy,
  });

  const first = await acquire();
  const second = await acquire();
  const queued = acquire();
  expect(await settlesNow(queued)).toBe(false);
  await expect(acquire()).rejects.toMatchObject(busy);

  first();
  const third = await queued;
  // The handed-over slot is still counted: a new caller queues, not runs.
  const waiting = acquire();
  expect(await settlesNow(waiting)).toBe(false);

  second();
  third();
  const fourth = await waiting;
  fourth();

  // Every slot is free again.
  const releases = [await acquire(), await acquire()];
  for (const release of releases) release();
});

test('waiters are admitted in arrival order', async () => {
  const acquire = createAdmission({
    slots: 1,
    queueLimit: 3,
    refusal: processingBusy,
  });
  const order: number[] = [];
  const holder = await acquire();
  const queued = [1, 2, 3].map(async (n) => {
    const release = await acquire();
    order.push(n);
    release();
  });
  holder();
  await Promise.all(queued);
  expect(order).toEqual([1, 2, 3]);
});

test('a waiter past its deadline is refused and never admitted later', async () => {
  const acquire = createAdmission({
    slots: 1,
    queueLimit: 2,
    maxWaitMs: 20,
    refusal: processingBusy,
  });
  const holder = await acquire();
  const started = Date.now();
  await expect(acquire()).rejects.toMatchObject(busy);
  expect(Date.now() - started).toBeGreaterThanOrEqual(15);

  // Its queue place was freed: the handover goes to a live waiter, and the
  // slot is not leaked to the expired one.
  const live = acquire();
  holder();
  const release = await live;
  release();
  const again = await acquire();
  expect(await settlesNow(Promise.resolve(again))).toBe(true);
  again();
});

test('a release called twice frees one slot, not two', async () => {
  const acquire = createAdmission({
    slots: 1,
    queueLimit: 1,
    refusal: processingBusy,
  });
  const release = await acquire();
  release();
  release();
  const held = await acquire();
  // A double release would have left a second slot free.
  const extra = acquire();
  expect(await settlesNow(extra)).toBe(false);
  held();
  (await extra)();
});

test('a waiter past its deadline when the slot frees is refused, and the next live one admitted', async () => {
  const acquire = createAdmission({
    slots: 1,
    queueLimit: 2,
    maxWaitMs: 20,
    refusal: processingBusy,
  });
  const holder = await acquire();
  const expired = acquire();
  // Blocks the thread past the deadline, so the waiter's timer has not run
  // when the holder releases.
  const blockedUntil = performance.now() + 60;
  while (performance.now() < blockedUntil) {
    // busy-wait on purpose: a timer would let the deadline fire first
  }
  const live = acquire();
  holder();
  await expect(expired).rejects.toMatchObject(busy);
  // The slot went to the live waiter behind it.
  const admitted = await live;
  admitted();
});
