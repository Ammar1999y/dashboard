import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { orphanedObjects } from '@/db/schema';

import { purgeUrls } from '@/lib/cloudflare/purge';
import { deleteFromR2, getPublicUrl, hasPublicUrl } from '@/lib/r2/client';

import { errorTypeOf, logSanitized } from '@/utils/log';

/** Each demand costs an R2 delete and possibly a purge call. */
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
 * On the id AND `cleanup_requests`, never the key alone: another abandoned
 * writer's copy of the same object bumps the counter, and clearing by key would
 * drop the retry that writer relies on.
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
 * `removeObject` made durable for a caller whose file row is gone: recorded
 * before the attempt and cleared only after it succeeds, since nothing else
 * would ever retry a failure. A refused clear leaves the row to the newer
 * writer that bumped it.
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
 * Only the bucket each row names, unlike `finishDeleting`: the file's own
 * delete has already swept every bucket.
 *
 * ⚠️ Least recently touched first, and a failure is restamped: oldest-first
 * starves everything behind one batch of persistent failures.
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
