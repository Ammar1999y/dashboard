import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SqliteConnection } from './driver';

import { openConnection } from './driver';

/** Each migration runs once, in order, under the migration lock. */
export type Migration = (db: SqliteConnection) => void;

/**
 * `process-crash-safe` is WAL + `synchronous = NORMAL`: consistent across a
 * process crash, but recent commits may be lost on host power loss. Zero-RPO
 * counters need FULL or a durable shared authority instead.
 */
type Durability = 'process-crash-safe' | 'disposable';

export interface OpenOptions {
  path: string;
  migrations: readonly Migration[];
  durability: Durability;
}

/**
 * Deliberately small: `journal_mode` and `synchronous` dominated every other
 * setting by orders of magnitude, and `mmap_size`, `cache_size`, `temp_store`
 * and a larger `page_size` measured no gain alone and worse stacked. Do not add
 * a setting without a measurement on the Linux target showing a gain.
 */
const BASE_PRAGMAS = [
  // Without WAL every read blocks on every write and the whole API serialises.
  'journal_mode = WAL',
  // Bounds the size the WAL is TRUNCATED TO after a checkpoint, not its growth:
  // while a long-lived read snapshot blocks checkpointing the WAL grows without
  // limit whatever this says. Peak WAL is an operational concern (disk
  // monitoring, a periodic `wal_checkpoint(TRUNCATE)`).
  'journal_size_limit = 67108864',
  // No schema object here calls an application-defined SQL function.
  'trusted_schema = OFF',
] as const;

/**
 * A fresh `bun:sqlite` connection starts at `busy_timeout = 0`, so without this
 * every lock conflict fails instantly. Kept short because the driver is
 * synchronous: a busy wait blocks the worker's whole event loop, and a long
 * stall on a login rate-limit check is worse than failing it. If this ceiling
 * is reached in practice the answer is a shared store, not a longer timeout.
 */
export const BUSY_TIMEOUT_MS = 2000;

/** `PRAGMA synchronous` reads back as an integer: NORMAL is 1, OFF is 0. */
export const SYNCHRONOUS_VALUE: Record<Durability, number> = {
  'process-crash-safe': 1,
  disposable: 0,
};

function applyPragmas(db: SqliteConnection, durability: Durability) {
  // First: `journal_mode = WAL` takes a lock, and it is the statement most
  // likely to contend on a cold start.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  for (const pragma of BASE_PRAGMAS) db.pragma(pragma);
  db.pragma(
    `synchronous = ${durability === 'process-crash-safe' ? 'NORMAL' : 'OFF'}`
  );
}

/**
 * The whole check-and-migrate runs inside ONE `BEGIN IMMEDIATE`. Reading
 * `user_version` before taking the write lock lets two processes starting
 * together both read 0 and both run the same DDL; the loser then fails with
 * `table ... already exists`.
 *
 * A newer-than-supported schema is refused rather than written through. The
 * check runs at first store use in a process, so it stops a stale container
 * from starting on a newer schema, not one already running; deploy ordering
 * stays an operational concern.
 */
function migrate(db: SqliteConnection, migrations: readonly Migration[]): void {
  db.transactionImmediate(() => {
    const current = Number(db.pragmaValue('user_version') ?? 0);

    if (current > migrations.length) {
      throw new Error(
        `SQLite schema is at version ${current}, newer than this build supports (${migrations.length}). ` +
          'Refusing to run: an older build must not write through a newer schema.'
      );
    }

    for (let version = current; version < migrations.length; version++) {
      const step = migrations[version];
      if (!step) continue;
      step(db);
      // Interpolated because `user_version` cannot be bound; `version` is a
      // loop index over a literal array.
      db.pragma(`user_version = ${version + 1}`);
    }
  })();
}

export function openDatabase(options: OpenOptions): SqliteConnection {
  // A fresh Coolify volume is mounted empty.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deployment-configured path, not user input
  mkdirSync(path.dirname(options.path), { recursive: true });

  const db = openConnection(options.path);
  // A failed PRAGMA or migration must not abandon the native handle and its
  // writer lock: fail-open callers retry on every request.
  try {
    applyPragmas(db, options.durability);
    migrate(db, options.migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Readiness uses this to prove the opened file is configured as intended. */
export function describeDatabase(db: SqliteConnection): {
  journalMode: unknown;
  synchronous: unknown;
  busyTimeout: unknown;
  userVersion: unknown;
} {
  return {
    journalMode: db.pragmaValue('journal_mode'),
    synchronous: db.pragmaValue('synchronous'),
    busyTimeout: db.pragmaValue('busy_timeout'),
    userVersion: db.pragmaValue('user_version'),
  };
}

/**
 * `quick_check`, not `integrity_check`: it skips the index-versus-table
 * cross-validation, and is still too costly for every readiness poll.
 */
export function quickCheck(db: SqliteConnection): string {
  // Finalized here because this runs per manual health poll; left to the
  // connection, one statement per call would accumulate for the process.
  const statement = db.prepare('PRAGMA quick_check');
  try {
    const row = statement.get<Record<string, unknown>>();
    const value = row ? Object.values(row)[0] : undefined;
    return typeof value === 'string' ? value : 'unknown';
  } finally {
    statement.finalize();
  }
}
