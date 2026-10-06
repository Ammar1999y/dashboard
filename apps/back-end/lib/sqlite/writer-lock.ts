import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SqliteConnection } from './driver';

import { isSqliteBusy, openConnection } from './driver';

const LOCK_FILE = '.writer-lock.db';

export interface WriterLock {
  release: () => void;
}

function claimFailure(directory: string, error: unknown): Error {
  return new Error(
    `Could not claim the SQLite directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  );
}

/**
 * Elects THIS process as the owner of a SQLite directory's scheduled sweeps,
 * or returns `null` when another process or thread already owns it. Losing is
 * not an error: `scheduleWhenOwner` serves without a schedule and claims again.
 *
 * An ownership lock, not a mutex on the databases: it holds an exclusive
 * transaction on a separate marker file, so `rate-limit.db` and `cache.db`
 * stay readable and writable by any other SQLite client, a backup included.
 *
 * It elects per directory only. Containers on separate volumes each win their
 * own, which is why the jobs acting on PostgreSQL or R2 are elected again per
 * run (`lib/maintenance/election.ts`).
 */
export function tryAcquireWriterLock(directory: string): WriterLock | null {
  let db: SqliteConnection;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- deployment-configured path, not user input
    mkdirSync(directory, { recursive: true });
    db = openConnection(path.join(directory, LOCK_FILE));
  } catch (error) {
    throw claimFailure(directory, error);
  }
  try {
    // Rollback-journal EXCLUSIVE uses an OS-released file lock.
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    // Only contention means "owned elsewhere"; any other failure is a broken directory.
    if (isSqliteBusy(error)) return null;
    throw claimFailure(directory, error);
  }

  const state = { released: false };
  return {
    release: () => {
      if (state.released) return;
      state.released = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        // Closing below releases the lock even if rollback is no longer possible.
      }
      db.close();
    },
  };
}
