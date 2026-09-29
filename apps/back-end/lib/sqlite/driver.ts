/**
 * The ONLY module that knows which SQLite driver is in use. `bun:sqlite`,
 * because the server runs under Bun and `better-sqlite3` is built against the
 * V8 C++ API, which Bun does not provide (oven-sh/bun#4290).
 *
 * If the driver ever changes, re-check each of these:
 *
 * 1. `bun:sqlite` creates the file only when asked (`create: true`).
 * 2. A PRAGMA is a statement here (`db.run('PRAGMA ...')`), read back through a
 *    prepared statement.
 * 3. A missing row is `null`, not `undefined`; every caller tests falsiness.
 * 4. BLOB columns arrive as `Uint8Array`; readers decode with `TextDecoder`.
 * 5. `prepare()` over `query()`: `query()` caches by SQL string in a bounded
 *    cache, and every statement here is held for the process, so an eviction
 *    finalising one would be a latent failure.
 * 6. Integers past 2^53 lose precision. Do not enable `safeIntegers`: it
 *    returns EVERY integer as a bigint, which breaks `JSON.stringify`, and the
 *    largest stored value is a millisecond timestamp.
 * 7. The bounded sweeps use `DELETE ... LIMIT`, which needs
 *    `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. Without it, rewrite as
 *    `DELETE FROM t WHERE key IN (SELECT key FROM t WHERE ... LIMIT ?)`.
 * 8. `close(true)` finalizes outstanding statements; see `close` below.
 *
 * Callers use anonymous `?` placeholders, never `?1`: `better-sqlite3` rejects
 * numbered placeholders bound positionally, so they would pin this driver.
 */
import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

export interface SqliteStatement {
  get<Row>(...params: readonly SqliteBindValue[]): Row | null;
  all<Row>(...params: readonly SqliteBindValue[]): Row[];
  /** `changes` is how the bounded sweep knows a batch came up short. */
  run(...params: readonly SqliteBindValue[]): { changes: number };
  /**
   * Idempotent, and unnecessary for a statement that lives as long as its
   * connection: `close()` finalizes those. Needed for shorter-lived ones such
   * as the per-poll `quick_check`. A driver without per-statement release would
   * make that caller leak, so check for one before swapping.
   */
  finalize(): void;
}

type SqliteBindValue = string | number | bigint | Uint8Array | null;

export interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** e.g. `journal_mode = WAL`. */
  pragma(statement: string): void;
  pragmaValue(name: string): unknown;
  /**
   * `BEGIN IMMEDIATE`: takes the write lock before the body runs. Required
   * wherever two processes could both read the same pre-state and act on it.
   *
   * Zero-argument by design: a generic argument tuple cannot pass through
   * `better-sqlite3`'s invariant `Transaction<F>` without a cast. Widen only if
   * a caller genuinely needs bound arguments.
   */
  transactionImmediate(fn: () => void): () => void;
  close(): void;
}

export function openConnection(path: string): SqliteConnection {
  // The path comes from SQLITE_DIR (deployment configuration), never a request.
  const db = new Database(path, { create: true, readwrite: true });

  return {
    prepare(sql) {
      const statement = db.prepare<unknown, SQLQueryBindings[]>(sql);
      return {
        get: (...params) => statement.get(...params) as never,
        all: (...params) => statement.all(...params) as never,
        run: (...params) => ({ changes: statement.run(...params).changes }),
        finalize: () => statement.finalize(),
      };
    },
    exec: (sql) => {
      db.run(sql);
    },
    pragma: (statement) => {
      db.run(`PRAGMA ${statement}`);
    },
    pragmaValue: (name) => {
      // Not `query`: that caches the compiled statement for the connection's
      // lifetime, and this is a one-off read.
      const statement = db.prepare<Record<string, unknown>, []>(
        `PRAGMA ${name}`
      );
      try {
        const row = statement.get();
        return row ? Object.values(row)[0] : undefined;
      } finally {
        statement.finalize();
      }
    },
    transactionImmediate: (fn) => db.transaction(fn).immediate,
    // `true`: `close(false)` (SQLite's `close_v2`) reports success while
    // deferring the real close until every prepared statement is gone, so the
    // handle and its file lock stay held — which defeats `lazyStore` closing a
    // connection whose prepare failed. A replacement driver that neither
    // finalizes nor tolerates outstanding statements needs a registry here.
    close: () => db.close(true),
  };
}
