import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { orphanedObjects } from '@/db/schema';

import { purgeUrls } from '@/lib/cloudflare/purge';
import { deleteFromR2, getPublicUrl, hasPublicUrl } from '@/lib/r2/client';

import { errorTypeOf, logSanitized } from '@/utils/log';

/**
 * Orphan demands one drain pass will work through, each an R2 delete and
 * possibly a purge call. The table holds a row only for a leftover whose delete
 * already failed once.
 */
export const ORPHAN_DRAIN_BATCH = 100;

/**
 * Removes one object and, for a public one with the purge configured, its edge
 * copy. Never throws — every caller is already handling a failure.
 */
export async function removeObject(
  key: string,
  bucketType: BucketType
): Promise<boolean> {
  try {
    await deleteFromR2({ key, bucketType });
    if (bucketType === 'public' && hasPublicUrl()) {
      const purge = await purgeUrls([getPublicUrl(key)]);
      // An object gone from the origin but still served from the edge is not
      // gone, so this counts as a failed cleanup and the marker stays.
      if (purge.failed.length > 0) return false;
    }
    return true;
  } catch (error) {
    logSanitized('error', {
      msg: 'media.transition cleanup failed',
      errorClass: errorTypeOf(error),
    });
    return false;
  }
}

/** One demand as its holder read it; the pair a clear has to match again. */
interface OrphanDemand {
  id: EntityID;
  requests: number;
}

/**
 * Clear one drained demand — and only while it is still the demand this holder
 * read.
 *
 * On the row identity AND on `cleanup_requests`, never on `(r2_key,
 * bucket_type)` alone: another abandoned writer recording its own copy of the
 * same object bumps the counter, and clearing by key would delete the retry that
 * writer is relying on. A refused clear leaves the row for whoever bumped it.
 * See `orphanedObjects.cleanupRequests`.
 */
async function clearOrphanDemand(demand: OrphanDemand): Promise<boolean> {
  const cleared = await db
    .delete(orphanedObjects)
    .where(
      and(
        eq(orphanedObjects.id, demand.id),
        eq(orphanedObjects.cleanupRequests, demand.requests)
      )
    )
    .returning({ id: orphanedObjects.id });
  return cleared.length > 0;
}

/**
 * `removeObject`, made durable, for the one caller whose row is already gone.
 *
 * Recorded before the attempt and cleared only after it succeeds: with the file
 * row gone there is no marker, counter or `deleting` row to fall back on, so an
 * unrecorded failure is a leftover nothing will ever retry. See
 * `orphanedObjects`.
 *
 * The enqueue advances `cleanup_requests` on conflict rather than doing nothing,
 * because two abandoned writers can hold a copy of the same key in the same
 * bucket, and the clear has to tell its own demand from a newer one. A writer
 * whose clear is refused has still removed every copy that landed before it —
 * each writer records only after its own copy has landed — so the surviving row
 * is the newer writer's.
 */
export async function removeOrphanedObject(
  key: string,
  bucketType: BucketType
): Promise<boolean> {
  const [demand] = await db
    .insert(orphanedObjects)
    .values({ r2Key: key, bucketType })
    .onConflictDoUpdate({
      target: [orphanedObjects.r2Key, orphanedObjects.bucketType],
      set: {
        cleanupRequests: sql`${orphanedObjects.cleanupRequests} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: orphanedObjects.id,
      requests: orphanedObjects.cleanupRequests,
    });
  if (!(await removeObject(key, bucketType))) return false;
  if (demand) await clearOrphanDemand(demand);
  return true;
}

/**
 * Finish the deletes recorded by `removeOrphanedObject`.
 *
 * Each row names the exact bucket its leftover is in, so this deletes from that
 * one rather than from every enabled bucket the way `finishDeleting` does: by
 * the time a row lands here the file's own delete has already swept them all.
 * A row survives its own failure and is retried on the next pass; `failed` is
 * what makes the retention sweep report `degraded` until it clears.
 *
 * ⚠️ Least recently touched first, and a failed attempt is restamped. Oldest
 * first starves: once a batch's worth of demands fail for a reason of their own,
 * every later pass selects that same prefix and nothing behind it is attempted.
 * Restamping makes the queue a rotation, so every outstanding demand is reached
 * within ⌈rows / batch⌉ passes.
 *
 * `hasMore` reports work this bounded pass did not settle — rows it never
 * reached, and rows a concurrent writer re-recorded while it was working — which
 * is a backlog rather than a failure and is reported separately from `failed`.
 */
export async function sweepOrphanedObjects(): Promise<{
  removed: number;
  failed: number;
  hasMore: boolean;
}> {
  const due = await db
    .select({
      id: orphanedObjects.id,
      r2Key: orphanedObjects.r2Key,
      bucketType: orphanedObjects.bucketType,
      requests: orphanedObjects.cleanupRequests,
    })
    .from(orphanedObjects)
    .orderBy(orphanedObjects.updatedAt, orphanedObjects.id)
    .limit(ORPHAN_DRAIN_BATCH);

  let removed = 0;
  let failed = 0;
  let deferred = 0;
  for (const row of due) {
    if (!(await removeObject(row.r2Key, row.bucketType))) {
      failed += 1;
      // Yields this row's place in the queue; see the ordering note above.
      await db
        .update(orphanedObjects)
        .set({ updatedAt: sql`now()` })
        .where(eq(orphanedObjects.id, row.id));
      continue;
    }
    removed += 1;
    // The object is gone either way; a refused clear means a newer writer owns
    // the row now and its own delete is still outstanding.
    if (!(await clearOrphanDemand(row))) deferred += 1;
  }
  if (failed > 0)
    logSanitized('error', {
      msg: 'media.orphan drain could not finish every recorded delete',
      count: failed,
    });
  return {
    removed,
    failed,
    hasMore: due.length === ORPHAN_DRAIN_BATCH || deferred > 0,
  };
}
