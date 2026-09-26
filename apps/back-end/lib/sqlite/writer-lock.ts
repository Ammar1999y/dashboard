import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SqliteConnection } from './driver';

import { openConnection } from './driver';

const LOCK_FILE = '.writer-lock.db';

interface WriterLock {
  release: () => void;
}

/**
 * Claims a SQLite directory for THIS application instance.
 *
 * An ownership lock, not a mutex on the databases: it holds an exclusive
 * transaction on a separate marker file, so `rate-limit.db` and `cache.db`
 * stay readable and writable by any other SQLite client, a backup included.
 * What it stops is a SECOND APP INSTANCE starting on the same volume, which is
 * why deployment is stop-first rather than rolling.
 *
 * It does not exist because concurrent WAL writers malfunction; they do not.
 * It exists because the scheduled sweeps (`lib/maintenance/schedule.ts`) are
 * registered per process and are unsafe to run twice, and this lock is what
 * elects their single owner.
 */
export function acquireWriterLock(directory: string): WriterLock {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deployment-configured path, not user input
  mkdirSync(directory, { recursive: true });

  const db: SqliteConnection = openConnection(path.join(directory, LOCK_FILE));
  try {
    // Rollback-journal EXCLUSIVE uses an OS-released file lock.
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    throw new Error(
      `Another application instance already owns the SQLite directory ${directory}. ` +
        'This deployment assumes ONE instance per directory: the scheduled sweeps ' +
        'in lib/maintenance/schedule.ts are registered per process, so a second instance runs ' +
        'a second retention sweep against the same rows. Check for a second app ' +
        'container mounting the same volume, a leftover process, or a script ' +
        'pointed at the production SQLITE_DIR. ' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
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
