import type { SqliteStatement } from './driver';

import { yieldToEventLoop } from '@/utils/event-loop';

/** Rows per statement: small enough that one commit is never a long lock hold. */
const BATCH_SIZE = 500;

/** Batches per table per run; a larger backlog is reported through `hasMore`. */
const MAX_BATCHES = 200;

export interface SweepResult {
  removed: number;
  /**
   * The per-run ceiling was reached. Conservative: a final batch that was
   * exactly full reports `true` even if it removed the last expired row, so
   * alert on sustained `true`, not one occurrence.
   */
  hasMore: boolean;
}

/**
 * Deletes in bounded batches, yielding between them.
 *
 * Batching bounds the writer-lock hold, so limiter writes do not wait on
 * `busy_timeout` behind one unbounded DELETE. It does not free the event loop:
 * the driver is synchronous, so without the yield a large backlog still delays
 * every concurrent request by the sweep's full duration.
 *
 * `statement` must be a bounded delete taking `(cutoff, limit)`.
 */
export async function sweepInBatches(
  statement: SqliteStatement,
  cutoff: number
): Promise<SweepResult> {
  let removed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { changes } = statement.run(cutoff, BATCH_SIZE);
    removed += changes;
    if (changes < BATCH_SIZE) return { removed, hasMore: false };
    await yieldToEventLoop();
  }

  return { removed, hasMore: true };
}
