/**
 * WAL growth per limiter admission, on the real store: its migrations, its
 * pragmas, `SQL_CONSUME`.
 *
 * SQLite runs the auto-checkpoint inside whichever commit pushes the WAL past
 * `wal_autocheckpoint` pages, synchronously on the event loop, so frames per
 * admission set how often a request stalls behind one. An index over a column
 * the upsert's `SET` names is rewritten on every admission, even when the value
 * is unchanged, and adds at least one frame per admission: with the old
 * `expires_at` index one key measured 2.00 and distinct keys 2.85, against
 * 1.00 and 1.49 without it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  admitWindow,
  closeRateLimitStore,
  getRateLimitStore,
  RATE_LIMIT_SCHEMA_VERSION,
} from '@/lib/rate-limit/store';

import { resetSqliteStores } from '../helpers/sqlite';

/** Enough rows that a distinct key lands in a tree of realistic depth. */
const PREPOPULATED_KEYS = 2000;
const ADMISSIONS = 5000;
const WINDOW_START = 60_000_000;
const EXPIRES_AT = WINDOW_START + 60_000;

beforeEach(() => {
  resetSqliteStores();
});

afterEach(() => {
  resetSqliteStores();
});

function walFramesAfter(admit: (index: number) => void): number {
  const store = getRateLimitStore();
  // Off for the measurement only: a checkpoint mid-run would reset the WAL
  // being counted. The store is reset after each case.
  store.db.pragma('wal_autocheckpoint = 0');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (let index = 0; index < ADMISSIONS; index++) admit(index);
  const row = store.db
    .prepare('PRAGMA wal_checkpoint(PASSIVE)')
    .get<{ log: number }>();
  if (!row) throw new Error('wal_checkpoint returned no row');
  return row.log / ADMISSIONS;
}

function admit(key: string): void {
  admitWindow(getRateLimitStore(), {
    key,
    windowStart: WINDOW_START,
    cost: 1,
    expiresAt: EXPIRES_AT,
    limit: Number.MAX_SAFE_INTEGER,
  });
}

const ipKey = (prefix: string, index: number) =>
  `preauth.dash.users:ip:${prefix}.${index >> 8}.${index & 255}`;

test.each([
  ['the same key', 1, () => 'preauth.dash.users:ip:10.9.9.9'],
  ['distinct keys', 1.6, (index: number) => ipKey('10.0', index)],
] as const)(
  'an admission on %s writes at most %d WAL frames',
  (_label, budget, keyFor) => {
    for (let index = 0; index < PREPOPULATED_KEYS; index++)
      admit(ipKey('10.1', index));

    const frames = walFramesAfter((index) => admit(keyFor(index)));

    expect(frames).toBeLessThanOrEqual(budget);
  }
);

test('a file from before the drop loses the index when it is opened', () => {
  const previous = getRateLimitStore();
  previous.db.exec(
    'CREATE INDEX rate_limit_expires_at ON rate_limit (expires_at)'
  );
  previous.db.pragma(`user_version = ${RATE_LIMIT_SCHEMA_VERSION - 1}`);
  closeRateLimitStore();

  const { db } = getRateLimitStore();

  expect(db.pragmaValue('user_version')).toBe(RATE_LIMIT_SCHEMA_VERSION);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rate_limit' AND sql IS NOT NULL"
      )
      .all()
  ).toEqual([]);
});
