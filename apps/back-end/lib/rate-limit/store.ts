/**
 * The rate-limit database: its own file, separate from the response cache,
 * because one SQLite file has one writer lock and one WAL. A large cache write
 * would otherwise delay a login rate-limit check, and this store must be
 * crash-safe where the cache is disposable.
 *
 * Tables are `STRICT` (a wrong type fails instead of storing text in a
 * timestamp) and `WITHOUT ROWID` (the row is the index for a key-value table).
 */
import type { Migration } from '@/lib/sqlite/database';
import type { SweepResult } from '@/lib/sqlite/sweep';

import { RATE_LIMIT_DB_PATH } from '@/lib/env.server';
import { BUSY_TIMEOUT_MS, withoutBusyWait } from '@/lib/sqlite/database';
import { isSqliteBusy } from '@/lib/sqlite/driver';
import { lazyStore } from '@/lib/sqlite/store';
import { sweepInBatches } from '@/lib/sqlite/sweep';

/** Readiness compares the file's `user_version` against this. */
export const RATE_LIMIT_SCHEMA_VERSION = 3;

const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`CREATE TABLE rate_limit (
      key          TEXT    NOT NULL PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.exec(`CREATE INDEX rate_limit_expires_at ON rate_limit (expires_at)`);

    db.exec(`CREATE TABLE auth_rate_limit (
      key          TEXT    NOT NULL PRIMARY KEY,
      count        INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      last_request INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.exec(
      `CREATE INDEX auth_rate_limit_expires_at ON auth_rate_limit (expires_at)`
    );
  },

  (db) => {
    db.exec(`DROP TABLE IF EXISTS auth_rate_limit`);
  },

  (db) => {
    db.exec(`DROP INDEX IF EXISTS rate_limit_expires_at`);
  },
];

if (RATE_LIMIT_SCHEMA_VERSION !== MIGRATIONS.length)
  throw new Error(
    'RATE_LIMIT_SCHEMA_VERSION does not match the migration list'
  );

/**
 * Fixed-window admission as ONE statement, atomic across processes with no
 * explicit transaction. The `CASE` rolls an expired window over in place.
 *
 * Only a NEWER bound window rolls over, or one that ended before the stored
 * window began (the clock stepped back past it). A stale one (computed before
 * a boundary, committed after another process rolled the row) is charged to the
 * stored window; rewriting the row back to it would let the next current
 * caller roll over again and re-grant the whole budget.
 *
 * The `WHERE` on `DO UPDATE` makes it max-aware: a request already at the
 * limit inside the current window writes nothing, so hammering an exhausted
 * key adds no WAL, though the statement still takes the writer lock and waits
 * on another writer like any admission. A denied request therefore returns NO
 * row, which can only mean the row exists, is in the bound window or the next
 * one, and is at `max`; the caller derives `retryAfter` from the `windowStart`
 * it bound and must not read the row back, which would race a concurrent
 * rollover.
 *
 * `cost` is the units this admission spends. Neither the INSERT nor the
 * rollover branch can refuse, so the caller must reject `cost > max` first.
 *
 * Binds, in order: key, windowStart, cost, expiresAt, limit.
 */
const SQL_CONSUME = `
  INSERT INTO rate_limit (key, window_start, count, expires_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    count        = CASE WHEN excluded.window_start > rate_limit.window_start
                          OR rate_limit.window_start > excluded.expires_at
                        THEN excluded.count
                        ELSE rate_limit.count + excluded.count END,
    window_start = CASE WHEN excluded.window_start > rate_limit.window_start
                          OR rate_limit.window_start > excluded.expires_at
                        THEN excluded.window_start
                        ELSE rate_limit.window_start END,
    expires_at   = CASE WHEN excluded.window_start > rate_limit.window_start
                          OR rate_limit.window_start > excluded.expires_at
                        THEN excluded.expires_at
                        ELSE MAX(rate_limit.expires_at, excluded.expires_at) END
  WHERE excluded.window_start > rate_limit.window_start
     OR rate_limit.window_start > excluded.expires_at
     OR rate_limit.count + excluded.count <= ?
  RETURNING count, window_start`;

/**
 * Bounded, so a large backlog never holds the sole writer lock for long. A
 * scan, deliberately: `SQL_CONSUME` sets `expires_at` on every admission, so
 * an index on it doubled each admission's WAL writes and with them the
 * auto-checkpoint stalls, to speed up a job that runs every 15 minutes.
 */
const SQL_SWEEP_RATE_LIMIT = `DELETE FROM rate_limit WHERE expires_at <= ? LIMIT ?`;
/**
 * `EXISTS` stops the scan at the first expired row. One row is ALWAYS
 * returned, so read `present` rather than testing the row.
 */
const SQL_ANY_EXPIRED = `
  SELECT EXISTS(SELECT 1 FROM rate_limit WHERE expires_at <= ?) AS present`;

interface ConsumeRow {
  count: number;
  window_start: number;
}

const limiterStore = lazyStore(
  {
    path: RATE_LIMIT_DB_PATH,
    migrations: MIGRATIONS,
    durability: 'process-crash-safe',
  },
  (db) => ({
    consume: db.prepare(SQL_CONSUME),
    sweepRateLimit: db.prepare(SQL_SWEEP_RATE_LIMIT),
    anyExpired: db.prepare(SQL_ANY_EXPIRED),
  })
);

export const getRateLimitStore = limiterStore.get;
export const closeRateLimitStore = limiterStore.close;

/** One `SQL_CONSUME` admission against the store the caller already holds. */
export function admitWindow(
  store: ReturnType<typeof getRateLimitStore>,
  admission: {
    key: string;
    windowStart: number;
    cost: number;
    expiresAt: number;
    limit: number;
  }
): ConsumeRow | null {
  return store.consume.get<ConsumeRow>(
    admission.key,
    admission.windowStart,
    admission.cost,
    admission.expiresAt,
    admission.limit
  );
}

const BUSY_RETRY_MIN_MS = 5;
const BUSY_RETRY_MAX_MS = 50;

/**
 * `admitWindow` that waits out a held writer lock without blocking the thread:
 * each attempt fails at once and the retry is a timer, so every other request
 * keeps running. Gives up with the lock error after `BUSY_TIMEOUT_MS`, as the
 * blocking wait does. For a caller whose own timing must not depend on another
 * writer, which a blocked event loop would make it.
 */
export async function admitWindowWithoutBlocking(
  store: ReturnType<typeof getRateLimitStore>,
  admission: Parameters<typeof admitWindow>[1]
): Promise<ConsumeRow | null> {
  const giveUpAt = Date.now() + BUSY_TIMEOUT_MS;
  let delay = BUSY_RETRY_MIN_MS;
  for (;;) {
    try {
      return withoutBusyWait(store.db, () => admitWindow(store, admission));
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= giveUpAt) throw error;
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, BUSY_RETRY_MAX_MS);
  }
}

/**
 * Reclaims disk only: expiry is filtered on every read, so a late or failed
 * sweep never makes an expired row readable. Must run as ONE scheduled job
 * (`lib/maintenance/schedule.ts`), not per process.
 */
export function rateLimitSweepExpired(now = Date.now()): Promise<SweepResult> {
  return sweepInBatches(getRateLimitStore().sweepRateLimit, now);
}

export function rateLimitHasExpiredRows(now = Date.now()): boolean {
  const row = getRateLimitStore().anyExpired.get<{ present: number }>(now);
  return Boolean(row?.present);
}
