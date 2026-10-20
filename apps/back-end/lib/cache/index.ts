/**
 * Disposable response/GET cache on its own SQLite database, not a table in the
 * limiter's: one writer lock per file, so a large cache write cannot hold up a
 * login rate-limit check; `synchronous = OFF` here against the limiter's
 * crash-safe `NORMAL`; and a corrupt or oversized cache is fixed by deleting
 * the file, which must never take the security counters with it.
 *
 * Values are opaque BLOBs. Do not switch them to JSONB: for whole-value reads
 * by key it measured slower on both read and write. If a namespace ever needs
 * to read small fields out of large documents, give it its own JSONB column.
 *
 * ⚠️ SCAFFOLD: no call site uses this yet. Before the first one adopts it,
 * decide and write down the key namespace grammar, the total on-disk budget and
 * what enforces it, and the invalidation trigger, and schedule the expiry sweep
 * in `lib/maintenance/sqlite.ts`, which skips this store until then. A
 * per-value size cap is enforced; a total-size cap and an eviction policy are
 * NOT.
 */
import type { Migration } from '@/lib/sqlite/database';
import type { SweepResult } from '@/lib/sqlite/sweep';
import type * as z from 'zod';

import { CACHE_DB_PATH } from '@/lib/env.server';
import { lazyStore } from '@/lib/sqlite/store';
import { sweepInBatches } from '@/lib/sqlite/sweep';

import { logLine } from '@/utils/log';

import { prefixUpperBound } from './prefix';

const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`CREATE TABLE cache (
      key        TEXT    NOT NULL PRIMARY KEY,
      value      BLOB    NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.exec(`CREATE INDEX cache_expires_at ON cache (expires_at)`);
  },
];

const SQL_GET = `SELECT value FROM cache WHERE key = ? AND expires_at > ?`;
/** Binds, in order: key, value, expiresAt, createdAt. */
const SQL_SET = `
  INSERT INTO cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value      = excluded.value,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at`;
const SQL_DELETE = `DELETE FROM cache WHERE key = ?`;
/**
 * A half-open range, not `GLOB` or `LIKE`: a prefix containing either's
 * metacharacters would delete unrelated keys, and the range still uses the
 * primary-key index.
 *
 * Binds, in order: prefix, prefix upper bound.
 */
const SQL_DELETE_PREFIX = `DELETE FROM cache WHERE key >= ? AND key < ?`;
/** For a prefix with no successor: every key at or after it matches. */
const SQL_DELETE_FROM = `DELETE FROM cache WHERE key >= ?`;
const SQL_SWEEP = `DELETE FROM cache WHERE expires_at <= ? LIMIT ?`;
/**
 * An existence probe, not a count: `COUNT(*)` or `SUM(length(value))` is an
 * unbounded scan that grows with the cache, and payload length is not the disk
 * actually used. Monitor size from the filesystem.
 */
const SQL_ANY_EXPIRED = `SELECT 1 AS present FROM cache WHERE expires_at <= ? LIMIT 1`;

const cacheStore = lazyStore(
  { path: CACHE_DB_PATH, migrations: MIGRATIONS, durability: 'disposable' },
  (db) => ({
    read: db.prepare(SQL_GET),
    write: db.prepare(SQL_SET),
    del: db.prepare(SQL_DELETE),
    delPrefix: db.prepare(SQL_DELETE_PREFIX),
    delFrom: db.prepare(SQL_DELETE_FROM),
    sweep: db.prepare(SQL_SWEEP),
    anyExpired: db.prepare(SQL_ANY_EXPIRED),
  })
);

const getStore = cacheStore.get;
export const closeCacheStore = cacheStore.close;

const decoder = new TextDecoder();

const MAX_VALUE_BYTES = 512 * 1024;

/**
 * Null on a miss, an expired entry, a value `schema` rejects, or any store
 * failure: a cache that throws would need a try/catch at every call site to
 * stay invisible.
 *
 * @knipignore
 */
export function cacheGet<Value>(
  key: string,
  schema: z.ZodType<Value>
): Value | null {
  try {
    const row = getStore().read.get<{ value: Uint8Array }>(key, Date.now());
    if (!row) return null;
    const decoded: unknown = JSON.parse(decoder.decode(row.value));
    const parsed = schema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `ttlSeconds` is required: an entry with no expiry is not a cache entry. */
export function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number
): void {
  try {
    const encoded = Buffer.from(JSON.stringify(value));
    // The driver is synchronous, so a large write blocks the worker's whole
    // event loop; no cache entry is worth that.
    if (encoded.byteLength > MAX_VALUE_BYTES) {
      logLine('warn', {
        msg: 'cache value rejected: over size cap',
        bytes: encoded.byteLength,
        capBytes: MAX_VALUE_BYTES,
      });
      return;
    }
    const now = Date.now();
    getStore().write.run(key, encoded, now + ttlSeconds * 1000, now);
  } catch {
    // A failed write is a future miss, not a request failure.
  }
}

/** @knipignore */
export function cacheDelete(key: string): void {
  try {
    getStore().del.run(key);
  } catch {
    // See cacheSet.
  }
}

/**
 * Invalidates a whole namespace. An empty prefix throws rather than flushing
 * everything, so an unset variable surfaces as a bug instead of a slowdown.
 *
 * @knipignore
 */
export function cacheDeletePrefix(prefix: string): void {
  if (prefix.length === 0)
    throw new Error('cacheDeletePrefix requires a non-empty prefix');
  try {
    // `null`: the prefix is already maximal, so every key at or after it
    // starts with it and no upper bound applies.
    const upper = prefixUpperBound(prefix);
    const store = getStore();
    if (upper === null) store.delFrom.run(prefix);
    else store.delPrefix.run(prefix, upper);
  } catch {
    // See cacheSet.
  }
}

/** @knipignore */
export function cacheSweepExpired(now = Date.now()): Promise<SweepResult> {
  return sweepInBatches(getStore().sweep, now);
}

/** @knipignore */
export function cacheHasExpiredRows(now = Date.now()): boolean {
  return Boolean(getStore().anyExpired.get(now));
}
