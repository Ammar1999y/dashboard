import { expect, test } from 'bun:test';

import { HTTP_STATUS } from '@app/shared/http-status';
import { uploadMsg } from '@app/shared/messages/media';

import { createAdmission } from '@/lib/media/image/admission';

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
  const acquire = createAdmission({ slots: 2, queueLimit: 1 });

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
