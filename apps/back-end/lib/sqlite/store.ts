import type { OpenOptions } from './database';
import type { SqliteConnection } from './driver';

import { openDatabase } from './database';

type Store<Statements> = {
  readonly db: SqliteConnection;
} & Readonly<Statements>;

/**
 * One process-wide database with its statements prepared once.
 *
 * Opened on first `get`, not at import: a build step that evaluates the module
 * graph has no writable data volume.
 *
 * Published only after every prepare succeeds. A prepare can fail on a file
 * whose `user_version` is current but whose tables are missing, and callers
 * that fail open retry on every request, so an abandoned connection would
 * accumulate native handles until the file can no longer be renamed.
 *
 * `close` never opens: the shutdown path calls it, and opening a database in
 * order to close it would create the file and its WAL on a container that
 * never used it.
 */
export function lazyStore<Statements extends object>(
  options: OpenOptions,
  prepare: (db: SqliteConnection) => Statements
): { get: () => Store<Statements>; close: () => void } {
  const holder: { store: Store<Statements> | null } = { store: null };

  return {
    get: () => {
      if (holder.store) return holder.store;

      const db = openDatabase(options);
      try {
        const store: Store<Statements> = { db, ...prepare(db) };
        holder.store = store;
        return store;
      } catch (error) {
        db.close();
        throw error;
      }
    },
    close: () => {
      const { store } = holder;
      if (!store) return;
      holder.store = null;
      store.db.close();
    },
  };
}
