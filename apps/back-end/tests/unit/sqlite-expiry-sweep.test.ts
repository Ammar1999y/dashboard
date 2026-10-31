/**
 * `runMaintenanceSweep`, the `sqlite-expiry-sweep` job's body, against real
 * stores in this process's temporary `SQLITE_DIR`.
 */
import { beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { CACHE_DB_PATH } from '@/lib/env.server';
import { runMaintenanceSweep } from '@/lib/maintenance/sqlite';
import { admitWindow, getRateLimitStore } from '@/lib/rate-limit/store';

import { resetSqliteStores } from '../helpers/sqlite';

beforeEach(() => {
  resetSqliteStores();
});

test('the sweep removes expired limiter rows and keeps a live one', async () => {
  const now = Date.now();
  for (const [key, expiresAt] of [
    ['sweep.expired', now - 1000],
    ['sweep.live', now + 60_000],
  ] as const)
    admitWindow(getRateLimitStore(), {
      key,
      windowStart: expiresAt - 60_000,
      cost: 1,
      expiresAt,
      limit: 10,
    });

  const result = await runMaintenanceSweep(now);

  expect(result).toMatchObject({
    status: 'ok',
    removed: { rateLimit: { removed: 1, hasMore: false } },
    hasMore: false,
  });
  expect(
    getRateLimitStore().db.prepare('SELECT key FROM rate_limit').all()
  ).toEqual([{ key: 'sweep.live' }]);
});

/** `count` rows straight into the store, `expiredEvery`-th one expired at `now`. */
function seed(now: number, count: number, expiredEvery: number): number {
  const db = getRateLimitStore().db;
  const insert = db.prepare(
    'INSERT INTO rate_limit (key, window_start, count, expires_at) VALUES (?, ?, 1, ?)'
  );
  let expired = 0;
  db.transactionImmediate(() => {
    // The empty key first: the walk's cursor starts there, and an exclusive
    // start would skip it forever.
    for (let i = 0; i < count; i++) {
      const due = i % expiredEvery === 0;
      if (due) expired += 1;
      insert.run(
        i === 0 ? '' : `k${i}`,
        now - 120_000,
        due ? now - 1 : now + 60_000
      );
    }
  })();
  return expired;
}

const remaining = () =>
  getRateLimitStore()
    .db.prepare(
      'SELECT count(*) AS total, sum(expires_at <= ?) AS expired FROM rate_limit'
    )
    .get<{ total: number; expired: number | null }>(Date.now());

test('one run clears every expired row however large the table, a bounded window per statement', async () => {
  // The old sweep stopped after 100,000 rows (200 batches of 500), rescanning
  // the table from the start for each batch, so a flood of keys outgrew it.
  // One run now walks the whole key range.
  const rows = 310_000;
  const now = Date.now();
  const expired = seed(now, rows, 3);
  expect(expired).toBeGreaterThan(100_000);
  const deletes = spyOn(getRateLimitStore().sweep.deleteWindow, 'run');

  const result = await runMaintenanceSweep(now);

  expect(result).toMatchObject({
    removed: { rateLimit: { removed: expired, hasMore: false } },
    hasMore: false,
  });
  expect(remaining()).toEqual({ total: rows - expired, expired: 0 });
  // Several statements, none of them the whole backlog.
  expect(deletes.mock.calls.length).toBeGreaterThan(3);
  const largest = Math.max(
    ...deletes.mock.results.map((call) =>
      call.type === 'return' ? call.value.changes : 0
    )
  );
  expect(largest).toBeLessThanOrEqual(500);
  deletes.mockRestore();
});

test('a stop signal ends the run between windows and leaves the rest for the next one', async () => {
  const now = Date.now();
  const expired = seed(now, 3001, 1);
  const stopping = new AbortController();

  // Aborted once the first window has been deleted.
  const store = getRateLimitStore();
  const original = store.sweep.deleteWindow.run.bind(store.sweep.deleteWindow);
  const windows = { deleted: 0 };
  const spy = spyOn(store.sweep.deleteWindow, 'run').mockImplementation(
    (...params) => {
      windows.deleted += 1;
      stopping.abort();
      return original(...params);
    }
  );

  const result = await runMaintenanceSweep(now, stopping.signal);
  spy.mockRestore();

  expect(windows.deleted).toBe(1);
  expect(result.hasMore).toBe(true);
  // Every row is expired, so the one window deleted is the whole bound: one
  // commit never holds the writer lock for more than this many deletes.
  expect(result.removed.rateLimit.removed).toBe(500);
  expect(remaining()?.expired).toBe(expired - result.removed.rateLimit.removed);
});

test('the sweep does not create the cache database, which nothing uses yet', async () => {
  await runMaintenanceSweep();

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from SQLITE_DIR, which the preload set to a temp directory
  expect(existsSync(CACHE_DB_PATH)).toBe(false);
});
