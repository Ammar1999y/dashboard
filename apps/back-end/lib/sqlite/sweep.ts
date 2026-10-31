import type { SqliteConnection, SqliteStatement } from './driver';

import { yieldToEventLoop } from '@/utils/event-loop';

/**
 * Rows walked per statement, expired or not. It bounds both the writer-lock
 * hold (at most this many deletes in one commit) and the synchronous stall each
 * statement puts on the event loop, whatever the share of expired rows.
 */
const WINDOW_ROWS = 500;

export interface SweepResult {
  removed: number;
  /** The run stopped before the end of the table: shutdown asked it to. */
  hasMore: boolean;
}

export interface SweepStatements {
  windowEnd: SqliteStatement;
  deleteWindow: SqliteStatement;
  deleteTail: SqliteStatement;
}

/**
 * The statements for a keyset walk over `table`'s primary key, so each window
 * is a bounded range scan and no statement depends on an `expires_at` index:
 * the limiter dropped its index to halve the WAL writes of every admission
 * (`lib/rate-limit/store.ts`), and an unindexed `DELETE ... LIMIT` rescans the
 * table from the start on every batch.
 *
 * `table` must be a `WITHOUT ROWID` table keyed by `key TEXT` with an
 * `expires_at` column; it is interpolated, so it is a literal union.
 */
export function prepareExpirySweep(
  db: SqliteConnection,
  table: 'rate_limit' | 'cache'
): SweepStatements {
  return {
    // The first key of the NEXT window, or null when this one reaches the end.
    windowEnd: db.prepare(
      `SELECT key FROM ${table} WHERE key >= ? ORDER BY key LIMIT 1 OFFSET ?`
    ),
    deleteWindow: db.prepare(
      `DELETE FROM ${table} WHERE key >= ? AND key < ? AND expires_at <= ?`
    ),
    deleteTail: db.prepare(
      `DELETE FROM ${table} WHERE key >= ? AND expires_at <= ?`
    ),
  };
}

/**
 * Deletes every row expired at `cutoff` in one pass over the table, a window
 * at a time, yielding between windows: the driver is synchronous, so without
 * the yield a large table still delays every concurrent request by the whole
 * pass.
 *
 * A finished pass leaves no row that had expired at `cutoff`: a row written
 * behind the cursor during the pass expires after it. `stopping` ends the pass
 * between windows, and the next run starts over.
 */
export async function sweepExpiredRows(
  statements: SweepStatements,
  cutoff: number,
  stopping?: AbortSignal
): Promise<SweepResult> {
  let removed = 0;
  let from = '';

  for (;;) {
    if (stopping?.aborted) return { removed, hasMore: true };
    const next = statements.windowEnd.get<{ key: string }>(from, WINDOW_ROWS);
    removed += next
      ? statements.deleteWindow.run(from, next.key, cutoff).changes
      : statements.deleteTail.run(from, cutoff).changes;
    if (!next) return { removed, hasMore: false };
    from = next.key;
    await yieldToEventLoop();
  }
}
