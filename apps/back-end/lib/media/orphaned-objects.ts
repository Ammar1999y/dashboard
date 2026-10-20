import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { orphanedObjects } from '@/db/schema';

import { purgeUrls } from '@/lib/cloudflare/purge';
import { deleteFromR2, getPublicUrl, hasPublicUrl } from '@/lib/r2/client';

import { errorTypeOf, logLine, logSanitized } from '@/utils/log';

/**
 * Each demand costs an R2 delete; the pass shares its purges, one call per
 * `PURGE_BATCH_SIZE`.
 */
export const ORPHAN_DRAIN_BATCH = 100;

/**
 * The wall clock one maintenance pass may spend on R2 while its job holds an
 * election connection. The retention job runs two back to back, and the
 * weekly reconcile starts half an hour after it (`lib/maintenance/schedule.ts`).
 */
const PASS_BUDGET_MS = 10 * 60_000;
/** Each one is a whole SDK retry ladder (`lib/r2/client.ts`), about 46 s. */
const TIMEOUT_STREAK_LIMIT = 3;

/**
 * What a maintenance pass may still spend on R2. A pass checks `spent()`
 * before each call and leaves what it did not reach marked for the next run;
 * `signal` ends a call still in flight when the time runs out.
 */
export interface PassBudget {
  readonly signal: AbortSignal;
  spent(): 'time' | 'store timing out' | null;
  /** `undefined` for a call that succeeded. */
  record(error?: unknown): void;
}

export function passBudget(): PassBudget {
  const deadline = Date.now() + PASS_BUDGET_MS;
  const signal = AbortSignal.timeout(PASS_BUDGET_MS);
  let timeouts = 0;
  return {
    signal,
    spent: () =>
      timeouts >= TIMEOUT_STREAK_LIMIT
        ? 'store timing out'
        : signal.aborted || Date.now() >= deadline
          ? 'time'
          : null,
    record: (error) => {
      timeouts = errorTypeOf(error) === 'TimeoutError' ? timeouts + 1 : 0;
    },
  };
}

/** Logged once, when a pass leaves work for the next run. */
export function logPassStopped(
  pass: string,
  reason: NonNullable<ReturnType<PassBudget['spent']>>,
  left: number
): void {
  logLine('error', {
    msg: 'media.maintenance pass stopped early',
    pass,
    reason,
    left,
    effect: 'markers kept; the next run takes them',
  });
}

interface StoredObject {
  key: string;
  bucketType: BucketType;
}

/**
 * Removes an object from the bucket it names, and only there. Never throws —
 * every caller is already handling a failure.
 */
export async function deleteStoredObject(
  object: StoredObject,
  budget?: PassBudget
): Promise<boolean> {
  try {
    await deleteFromR2({ ...object, signal: budget?.signal });
    budget?.record();
    return true;
  } catch (error) {
    budget?.record(error);
    logSanitized('error', {
      msg: 'media.transition cleanup failed',
      errorClass: errorTypeOf(error),
    });
    return false;
  }
}

/**
 * For objects already gone from their bucket, whether the edge has dropped
 * them too: a public one with the purge configured costs a share of one purge
 * call per `PURGE_BATCH_SIZE`. An object gone from the origin but still served
 * from the edge is not gone, so its caller keeps its marker.
 */
export async function evictedFromEdge(
  removed: readonly StoredObject[]
): Promise<boolean[]> {
  const cached = (object: StoredObject) =>
    object.bucketType === 'public' && hasPublicUrl();
  const { failed } = await purgeUrls(
    removed.filter(cached).map((object) => getPublicUrl(object.key))
  );
  const unpurged = new Set(failed);
  return removed.map(
    (object) => !(cached(object) && unpurged.has(getPublicUrl(object.key)))
  );
}

async function removeObject(
  object: StoredObject,
  budget?: PassBudget
): Promise<boolean> {
  if (!(await deleteStoredObject(object, budget))) return false;
  const [evicted] = await evictedFromEdge([object]);
  return evicted === true;
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
  bucketType: BucketType,
  budget?: PassBudget
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
  if (!(await removeObject({ key, bucketType }, budget))) return false;
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

  const budget = passBudget();
  const reached: typeof due = [];
  const deleted: typeof due = [];
  for (const row of due) {
    const stop = budget.spent();
    if (stop) {
      logPassStopped('orphanedObjects', stop, due.length - reached.length);
      break;
    }
    reached.push(row);
    const object = { key: row.r2Key, bucketType: row.bucketType };
    if (await deleteStoredObject(object, budget)) deleted.push(row);
  }
  const evicted = await evictedFromEdge(
    deleted.map((row) => ({ key: row.r2Key, bucketType: row.bucketType }))
  );
  const gone = new Set(deleted.filter((_, index) => evicted[index]));

  let removed = 0;
  let failed = 0;
  let deferred = 0;
  for (const row of reached) {
    if (!gone.has(row)) {
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
    hasMore:
      due.length === ORPHAN_DRAIN_BATCH ||
      deferred > 0 ||
      reached.length < due.length,
  };
}
