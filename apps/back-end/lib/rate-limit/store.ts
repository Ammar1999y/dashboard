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
import { lazyStore } from '@/lib/sqlite/store';
import { sweepInBatches } from '@/lib/sqlite/sweep';

/** Readiness compares the file's `user_version` against this. */
export const RATE_LIMIT_SCHEMA_VERSION = 2;

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
];

if (RATE_LIMIT_SCHEMA_VERSION !== MIGRATIONS.length)
  throw new Error(
    'RATE_LIMIT_SCHEMA_VERSION does not match the migration list'
  );

/**
 * Fixed-window admission as ONE statement, atomic across processes with no
 * explicit transaction. The `CASE` rolls an expired window over in place.
 *
 * The `WHERE` on `DO UPDATE` makes it max-aware: a request already at the
 * limit inside the current window writes nothing, so hammering an exhausted
 * key creates no writer-lock contention. A denied request therefore returns NO
 * row, which can only mean the row exists, is in the bound window and is at
 * `max`; the caller derives `retryAfter` from the `windowStart` it bound and
 * must not read the row back, which would race a concurrent rollover.
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
    count        = CASE WHEN rate_limit.window_start = excluded.window_start
                        THEN rate_limit.count + excluded.count
                        ELSE excluded.count END,
    window_start = excluded.window_start,
    expires_at   = excluded.expires_at
  WHERE rate_limit.window_start <> excluded.window_start
     OR rate_limit.count + excluded.count <= ?
  RETURNING count, window_start`;

/** Bounded, so a large backlog never holds the sole writer lock for long. */
const SQL_SWEEP_RATE_LIMIT = `DELETE FROM rate_limit WHERE expires_at <= ? LIMIT ?`;
/**
 * `EXISTS` short-circuits on the `expires_at` index. One row is ALWAYS
 * returned, so read `present` rather than testing the row.
 */
const SQL_ANY_EXPIRED = `
  SELECT EXISTS(SELECT 1 FROM rate_limit WHERE expires_at <= ?) AS present`;

export interface ConsumeRow {
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
