import type { Actor } from './actor';
import type { MediaFileRow } from './files';
import type { FileTransition } from '@/db/schema';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files, orphanedObjects } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { purgeUrls } from '@/lib/cloudflare/purge';
import { generateUuidV7 } from '@/lib/id';
import {
  copyFileInR2,
  deleteFromR2,
  getPublicUrl,
  hasPublicUrl,
  headObjectInR2,
  isVisibilityEnabled,
} from '@/lib/r2/client';

import { sanitizeForLog } from '@/utils/log';

import { auditAs } from './actor';
import {
  downloadFilename,
  FILE_COLUMNS,
  governedIds,
  matchesRow,
} from './files';
import { getCacheControlHeader, getContentDisposition } from './headers';
import { mediaMsg } from './messages';
import { hasPublicUsage } from './usages';

/**
 * A transition older than this with its marker still set was abandoned by the
 * request that started it; the sweep finishes or reverts it. Generous against a
 * slow copy, short against a stale `to_public` that keeps a file unpublishable.
 */
const TRANSITION_STALE_AFTER = '10 minutes';

/**
 * How many times one cleanup will delete again because a losing attempt
 * recorded a copy landing during the previous delete (`files.cleanupRequests`).
 *
 * Small on purpose: every round is another R2 delete on the request's own clock.
 * Exhausting them leaves the marker set, which costs one staleness window —
 * `retryTransitions` finishes exactly this work.
 */
const CLEANUP_ROUNDS = 3;

/**
 * Orphan demands one drain pass will work through, each an R2 delete and
 * possibly a purge call. The table holds a row only for a leftover whose delete
 * already failed once.
 */
export const ORPHAN_DRAIN_BATCH = 100;

/**
 * Stalled sagas one recovery pass will work through. Each one is at least an R2
 * delete against the row's own clock.
 */
export const TRANSITION_RETRY_BATCH = 1000;

const other = (bucket: BucketType): BucketType =>
  bucket === 'public' ? 'private' : 'public';

const towards = (bucket: BucketType): FileTransition =>
  bucket === 'public' ? 'to_public' : 'to_private';

function targetHeaders(
  row: Pick<MediaFileRow, 'mimeType' | 'kind' | 'displayName'>,
  to: BucketType
) {
  return {
    contentType: row.mimeType,
    cacheControl: getCacheControlHeader({
      mimeType: row.mimeType,
      isPublic: to === 'public',
    }),
    contentDisposition: getContentDisposition({
      filename: downloadFilename(row),
      inline: row.kind === 'image',
    }),
  };
}

/**
 * Removes one object and, for a public one with the purge configured, its edge
 * copy. Never throws — every caller is already handling a failure.
 */
async function removeObject(
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
    console.error(
      sanitizeForLog({
        msg: 'media.transition cleanup failed',
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
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
async function removeOrphanedObject(
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
 * Ownership of the cleanup, and what a caller that cannot take it leaves behind.
 *
 * One statement: a caller that reads the row as busy and then records its
 * demand can have the owner clear the marker in between, leaving the demand on
 * an idle row nobody reads again. So claiming and recording are the same UPDATE.
 *
 * Three outcomes, all against the bucket the row does NOT name:
 * - the caller already owns the row — kept, and `updated_at` restamped so the
 *   staleness window covers the delete it is about to issue;
 * - the row is idle — claimed under a fresh `cleanup`, which also keeps the next
 *   publish out until the delete has finished;
 * - somebody else owns it — `cleanup_requests` is bumped, the demand the owner
 *   has to honour, and the caller gets nothing.
 *
 * No row at all is two states needing opposite handling — the row is gone, or
 * it now NAMES this bucket and the object in it is live — so the caller tells
 * them apart.
 */
async function claimCleanup(
  fileId: EntityID,
  bucketType: BucketType,
  token: string
): Promise<{ token: string; requests: number } | null> {
  const claim = generateUuidV7();
  const mine = sql`(${files.transitionId} = ${token}::uuid or ${files.transition} is null)`;
  const [row] = await db
    .update(files)
    .set({
      transition: sql`case when ${files.transition} is null then 'cleanup'::file_transition else ${files.transition} end`,
      transitionId: sql`case when ${files.transition} is null then ${claim}::uuid else ${files.transitionId} end`,
      cleanupRequests: sql`case when ${mine} then ${files.cleanupRequests} else ${files.cleanupRequests} + 1 end`,
      updatedAt: sql`case when ${mine} then now() else ${files.updatedAt} end`,
    })
    .where(and(eq(files.id, fileId), ne(files.bucketType, bucketType)))
    .returning({
      token: files.transitionId,
      requests: files.cleanupRequests,
    });
  if (!row?.token) return null;
  return row.token === token || row.token === claim
    ? { token: row.token, requests: row.requests }
    : null;
}

interface CleanupOutcome {
  /** The copy this caller is answerable for is gone from the store. */
  removed: boolean;
  /** The row as persisted once the marker was cleared, where there still is one. */
  row: MediaFileRow | null;
}

/**
 * Remove the copy in the bucket the row does NOT name — the only object any
 * caller here may delete — clear the transition marker, and answer with the
 * settled row.
 *
 * **Never the live object, and never one that can BECOME live while the delete
 * is in flight.** R2 has no conditional delete, so re-reading `bucket_type` is
 * not enough: another transition can copy into that bucket and commit between
 * the read and the delete. What holds across the call is the transition token —
 * while an attempt owns it, `transitionFile` refuses the row as busy and
 * `retryTransitions` cannot claim it inside the staleness window. So ownership
 * is re-asserted in the statement that also restamps `updated_at`, and one R2
 * delete (`R2_REQUEST_TIMEOUT_MS` × `maxAttempts`) must stay well inside
 * `TRANSITION_STALE_AFTER`.
 *
 * ⚠️ Another attempt's copy can land in that same bucket WHILE the delete is in
 * flight; its flip then fails and it has no marker to hand the leftover to.
 * `claimCleanup` covers it: the loser bumps `cleanup_requests`, the clear below
 * refuses to run against a bumped value, and this goes round again. Giving up
 * leaves the marker set, which is the sweep's own signal.
 *
 * ⚠️ And the row itself can be GONE — reverted by the sweep, then deleted —
 * while this caller's copy is in flight, leaving nothing that names the key:
 * `claimCleanup` matches nothing and reconciliation only reports. An absent row
 * is proof enough — the key embeds the row's primary key (`lib/media/keys.ts`)
 * and `ux_files_r2_key` is unique, so the key can never belong to anything
 * again — and the writer removes what it wrote through `removeOrphanedObject`,
 * so a failure is owed to the drain rather than lost.
 *
 * Every path that abandons a copy comes through here, the verification failure
 * as much as the lost flip; they differ only in which step noticed.
 */
async function removeStaleCopy(
  fileId: EntityID,
  key: string,
  bucketType: BucketType,
  transitionToken: string
): Promise<CleanupOutcome> {
  let token = transitionToken;
  for (let round = 0; round < CLEANUP_ROUNDS; round++) {
    const owned = await claimCleanup(fileId, bucketType, token);
    if (!owned) {
      const [live] = await db
        .select({ id: files.id })
        .from(files)
        .where(eq(files.id, fileId));
      if (!live) {
        console.error(
          sanitizeForLog({
            msg: 'media.transition stale copy outlived its row',
            id: fileId,
          })
        );
        return {
          removed: await removeOrphanedObject(key, bucketType),
          row: null,
        };
      }
      // Not this caller's row: the demand is recorded against the attempt that
      // owns it, or there is nothing to remove because the row names this
      // bucket itself and the object in it is live.
      console.error(
        sanitizeForLog({
          msg: 'media.transition stale copy handed to the transition that owns the row',
          id: fileId,
        })
      );
      return { removed: false, row: null };
    }
    token = owned.token;
    // A failure leaves the marker set, which is what the sweep picks up — and
    // for a `cleanup` row it deletes the bucket the row does not name, the one
    // claimed against here.
    if (!(await removeObject(key, bucketType)))
      return { removed: false, row: null };
    const [settled] = await db
      .update(files)
      .set({ transition: null, transitionId: null })
      .where(
        and(
          eq(files.id, fileId),
          eq(files.transitionId, token),
          eq(files.cleanupRequests, owned.requests)
        )
      )
      .returning(FILE_COLUMNS);
    if (settled) return { removed: true, row: settled };
  }
  return { removed: false, row: null };
}

/**
 * Move a file's object to the other bucket under the same key, and flip the row
 * once the copy is verified. Five steps, three of them transactions, none of
 * them open across the object store:
 *
 * 1. mark `transition` (refused if another saga owns the row, if the target is
 *    disabled, if the media API may not touch the row (`mediaGoverned`), or —
 *    for `to_private` — if a public owner still references it);
 * 2. `HeadObject` the source and check it against the row; copy with the
 *    target's headers; `HeadObject` the target and require the source's length
 *    and ETag — R2's single-part ETag is the content MD5, so equal ETags are
 *    equal bytes;
 * 3. flip `bucket_type`, mark `cleanup`, audit — from here URLs point at the
 *    target;
 * 4. delete the stale source object (and purge its public URL if it had one);
 * 5. clear the marker.
 *
 * A failure at 2 reverts: the target copy is removed and, only once that
 * removal succeeded, the marker cleared; otherwise the marker stays and
 * `retryTransitions` reverts later. A flip at 3 that matches no row means the
 * sweep cleared the marker while the copy was still in flight, so the copy that
 * has since landed is removed here — nothing else would ever look at it again.
 * A failure at 4 leaves `cleanup` for the same sweep. The row returned is the
 * PERSISTED state, so a caller sees `transition: 'cleanup'` when the stale copy
 * is still there.
 */
export async function transitionFile(params: {
  id: EntityID;
  to: BucketType;
  actor: Actor;
  /**
   * Owner code linking a file to a public purpose passes `true`. The media
   * routes leave it off, so an entity upload still held by its record cannot
   * be published or unpublished from the library.
   */
  authorizedByOwner?: boolean;
}): Promise<MediaFileRow> {
  const { id, to, actor } = params;
  if (!isVisibilityEnabled(to))
    throw new CustomError(
      mediaMsg.visibilityDisabled,
      HTTP_STATUS.UNPROCESSABLE
    );

  // This attempt's identity, minted before the row is touched so every guard
  // below can name it. See `files.transitionId`.
  const transitionToken = generateUuidV7();
  const ownedBy = (token: string) =>
    and(eq(files.id, id), eq(files.transitionId, token));

  const marked = await withTransaction(async (tx) => {
    const [row] = await tx
      .select(FILE_COLUMNS)
      .from(files)
      .where(eq(files.id, id))
      .for('update');
    const governed =
      row && params.authorizedByOwner !== true
        ? await governedIds(tx, [id])
        : null;
    if (
      !row ||
      (actor.scope === 'own' && row.uploadedBy !== actor.userId) ||
      (governed !== null && !governed.has(id))
    )
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
    if (row.status !== 'active' || row.transition)
      throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
    if (row.bucketType === to) return { row, done: true as const };
    if (to === 'private' && (await hasPublicUsage(id, tx)))
      throw new CustomError(mediaMsg.unpublishInUse, HTTP_STATUS.CONFLICT);

    await tx
      .update(files)
      .set({ transition: towards(to), transitionId: transitionToken })
      .where(eq(files.id, id));
    return { row, done: false as const };
  });
  if (marked.done) return marked.row;
  const { row } = marked;
  const from = row.bucketType;

  try {
    const source = await headObjectInR2({ key: row.r2Key, bucketType: from });
    if (!source || !matchesRow(source, row))
      throw new Error('source object does not match the row');
    await copyFileInR2({
      sourceKey: row.r2Key,
      destinationKey: row.r2Key,
      sourceBucketType: from,
      bucketType: to,
      replace: targetHeaders(row, to),
    });
    const target = await headObjectInR2({ key: row.r2Key, bucketType: to });
    if (
      !target ||
      target.contentLength !== row.sizeBytes ||
      target.etag !== source.etag
    )
      throw new Error('copied object does not match its source');
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'media.transition copy failed',
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
    const reverted = await removeStaleCopy(id, row.r2Key, to, transitionToken);
    if (!reverted.removed)
      console.error(
        sanitizeForLog({
          msg: 'media.transition revert left to the sweep',
          id,
        })
      );
    throw new CustomError(mediaMsg.storeFailed, HTTP_STATUS.INTERNAL_ERROR);
  }

  const flipped = await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({ bucketType: to, transition: 'cleanup' })
      // On the TOKEN, not on the marker value: `retryTransitions` writes the
      // same marker when it takes a stalled saga over, so a value match lets
      // this flip land while the sweep's delete of the target object is already
      // in flight, and the row then names a bucket with no object in it.
      .where(ownedBy(transitionToken))
      .returning(FILE_COLUMNS);
    if (!updated) return null;
    await auditAs(tx, actor, {
      action: 'UPDATE',
      tableName: 'files',
      recordId: id,
      oldData: { bucketType: from },
      newData: { bucketType: to },
    });
    return updated;
  });

  // The marker was cleared under us — `retryTransitions` reverted this saga
  // while the copy was still in flight — so the copy that has since landed in
  // the target bucket is the one nothing will look at again.
  if (!flipped) {
    await removeStaleCopy(id, row.r2Key, to, transitionToken);
    throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
  }

  // The PERSISTED state either way: a caller sees `transition: 'cleanup'` when
  // the stale copy is still there.
  const cleaned = await removeStaleCopy(id, row.r2Key, from, transitionToken);
  return cleaned.row ?? flipped;
}

/**
 * Finish or revert transitions a crashed request left behind.
 *
 * A row still at `to_public`/`to_private` never flipped, so nobody holds its
 * new URL: the copy in the target bucket is removed and the marker cleared. A
 * row at `cleanup` has flipped: the stale copy in the OTHER bucket is removed
 * and, for a public one, its edge copy purged. Every step is idempotent (a
 * missing key deletes as 204), so a second pass over the same row is harmless.
 *
 * `hasMore` reports rows this bounded pass never reached, which is a backlog and
 * not a failure — `failed` stays the count of attempts the store refused, and
 * the two drive different signals on the retention job.
 */
export async function retryTransitions(): Promise<{
  reverted: number;
  finished: number;
  failed: number;
  hasMore: boolean;
}> {
  const stuck = await db
    .select({ ...FILE_COLUMNS, transitionId: files.transitionId })
    .from(files)
    .where(
      and(
        isNotNull(files.transition),
        lt(files.updatedAt, sql`now() - ${TRANSITION_STALE_AFTER}::interval`)
      )
    )
    .limit(TRANSITION_RETRY_BATCH);

  let reverted = 0;
  let finished = 0;
  let failed = 0;
  for (const row of stuck) {
    // `chk_files_transition_owner` makes this state unreachable, so reaching it
    // means the constraint is gone — reported rather than skipped, because a
    // row with a marker and no token can never be claimed and would sit here
    // forever.
    if (!row.transition || !row.transitionId) {
      console.error(
        sanitizeForLog({
          msg: 'media.transition sweep found a saga with no owner token',
          id: row.id,
        })
      );
      failed += 1;
      continue;
    }

    // CLAIMED before a single byte is touched: the token, not the marker value
    // both sides write, is what makes this exclusive with a slow-but-alive
    // request still running the saga — its flip then fails its own guard and it
    // cleans up after itself. Still guarded on the staleness window, so a saga
    // started while this batch was read is not taken over at once.
    const claim = generateUuidV7();
    const [claimed] = await db
      .update(files)
      .set({ transitionId: claim })
      .where(
        and(
          eq(files.id, row.id),
          eq(files.transitionId, row.transitionId),
          lt(files.updatedAt, sql`now() - ${TRANSITION_STALE_AFTER}::interval`)
        )
      )
      .returning({ id: files.id });
    if (!claimed) continue;

    // Either way the copy to remove is in the bucket the row does NOT name: a
    // `cleanup` row has flipped and the stale source sits opposite; a `to_*` row
    // has not, and the unverified target copy sits opposite.
    const cleaned = await removeStaleCopy(
      row.id,
      row.r2Key,
      other(row.bucketType),
      claim
    );
    if (!cleaned.removed) {
      failed += 1;
      continue;
    }
    if (row.transition === 'cleanup') finished += 1;
    else reverted += 1;
  }
  return {
    reverted,
    finished,
    failed,
    hasMore: stuck.length === TRANSITION_RETRY_BATCH,
  };
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
    console.error(
      sanitizeForLog({
        msg: 'media.orphan drain could not finish every recorded delete',
        count: failed,
      })
    );
  return {
    removed,
    failed,
    hasMore: due.length === ORPHAN_DRAIN_BATCH || deferred > 0,
  };
}
