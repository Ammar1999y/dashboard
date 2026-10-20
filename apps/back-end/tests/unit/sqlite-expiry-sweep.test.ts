/**
 * `runMaintenanceSweep`, the `sqlite-expiry-sweep` job's body, against real
 * stores in this process's temporary `SQLITE_DIR`.
 */
import { beforeEach, expect, test } from 'bun:test';
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

test('the sweep does not create the cache database, which nothing uses yet', async () => {
  await runMaintenanceSweep();

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from SQLITE_DIR, which the preload set to a temp directory
  expect(existsSync(CACHE_DB_PATH)).toBe(false);
});
