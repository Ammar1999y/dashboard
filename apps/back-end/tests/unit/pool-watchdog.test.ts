/**
 * The watchdog ends the process only for a pool that is still unusable on a
 * second look: a pool replacing a dropped connection must not restart it.
 */
import { afterEach, expect, test } from 'bun:test';

import { watchApplicationPool } from '@/lib/pool-watchdog';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function watch(answers: boolean[]) {
  const wedged = { count: 0 };
  const queue = [...answers];
  stops.push(
    watchApplicationPool({
      usable: async () => queue.shift() ?? true,
      onWedged: () => {
        wedged.count += 1;
      },
      intervalMs: 10,
      confirmMs: 10,
    })
  );
  return wedged;
}

test('a pool unusable on both looks ends the process', async () => {
  const wedged = watch([false, false]);
  await Bun.sleep(80);
  expect(wedged.count).toBe(1);
});

test('a pool that recovers before the second look does not', async () => {
  const wedged = watch([false, true]);
  await Bun.sleep(80);
  expect(wedged.count).toBe(0);
});

test('a usable pool does not', async () => {
  const wedged = watch([true, true, true]);
  await Bun.sleep(80);
  expect(wedged.count).toBe(0);
});

test('a watch stopped during the second look does not', async () => {
  const wedged = watch([false, false]);
  await Bun.sleep(12);
  stops.splice(0).forEach((stop) => stop());
  await Bun.sleep(40);
  expect(wedged.count).toBe(0);
});
