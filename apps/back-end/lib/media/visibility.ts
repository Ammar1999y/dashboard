import type { Actor } from './actor';
import type { MediaFileRow } from './files';
import type { FileTransition } from '@/db/schema';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';

import { generateUuidV7 } from '@/lib/id';
import {
  copyFileInR2,
  headObjectInR2,
  isVisibilityEnabled,
} from '@/lib/r2/client';

import { errorTypeOf, logSanitized } from '@/utils/log';

import { auditAs, withinScope } from './actor';
import {
  downloadFilename,
  FILE_COLUMNS,
  governedIds,
  matchesRow,
} from './files';
import { objectHeaders } from './headers';
import { removeObject, removeOrphanedObject } from './orphaned-objects';
import { hasPublicUsage } from './usages';

/**
 * Past this a set marker counts as abandoned and the sweep takes it over. Must
 * outlast a slow copy; too long keeps an abandoned file unpublishable.
 */
const TRANSITION_STALE_AFTER = '10 minutes';

const staleTransition = () =>
  lt(files.updatedAt, sql`now() - ${TRANSITION_STALE_AFTER}::interval`);

/**
 * Small on purpose: each round is another R2 delete on the request's clock, and
 * exhausting them only leaves the marker for `retryTransitions`.
 */
const CLEANUP_ROUNDS = 3;

/** Each stalled saga costs at least one R2 delete. */
export const TRANSITION_RETRY_BATCH = 1000;

const other = (bucket: BucketType): BucketType =>
  bucket === 'public' ? 'private' : 'public';

const towards = (bucket: BucketType): FileTransition =>
  bucket === 'public' ? 'to_public' : 'to_private';

/**
 * Claims the cleanup, or records the demand on the attempt that owns it. One
 * UPDATE on purpose: reading "busy" and then recording lets the owner clear the
 * marker in between, stranding the demand on an idle row. A claim restamps
 * `updated_at` so the staleness window covers the delete about to be issued.
 *
 * `null` is also returned when the row is gone or now names this bucket (its
 * object is live); those need opposite handling, so the caller tells them apart.
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
 * Deletes the copy in the bucket the row does NOT name, the only object this
 * module may delete, and clears the marker. Every abandoned copy comes here.
 *
 * R2 has no conditional delete, so only the transition token keeps that bucket
 * from becoming live mid-delete: one R2 delete (`R2_REQUEST_TIMEOUT_MS` ×
 * `maxAttempts`) must stay well inside `TRANSITION_STALE_AFTER`.
 *
 * ⚠️ A copy landing during the delete bumps `cleanup_requests`, which refuses
 * the clear below and sends this round again.
 * ⚠️ A missing row proves the key dead (it embeds the primary key and
 * `ux_files_r2_key` is unique); nothing else names it, so the copy goes to
 * `removeOrphanedObject`.
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
        logSanitized('error', {
          msg: 'media.transition stale copy outlived its row',
          id: fileId,
        });
        return {
          removed: await removeOrphanedObject(key, bucketType),
          row: null,
        };
      }
      // The owning attempt now holds the demand, or the object here is live.
      logSanitized('error', {
        msg: 'media.transition stale copy handed to the transition that owns the row',
        id: fileId,
      });
      return { removed: false, row: null };
    }
    token = owned.token;
    // A failure leaves the marker set for the sweep, which deletes this bucket.
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
 * Copies the object to the other bucket under the same key and flips the row
 * once the copy is verified; no transaction stays open across the object store.
 * Equal ETags prove equal bytes: R2's single-part ETag is the content MD5.
 *
 * Returns the PERSISTED row, so a caller sees `transition: 'cleanup'` while the
 * stale copy is still there.
 */
export async function transitionFile(params: {
  id: EntityID;
  to: BucketType;
  actor: Actor;
  /**
   * Only owner code linking a file to a public purpose sets this, so the
   * library cannot move an upload its record still holds.
   */
  authorizedByOwner?: boolean;
}): Promise<MediaFileRow> {
  const { id, to, actor } = params;
  if (!isVisibilityEnabled(to))
    throw new CustomError(
      mediaMsg.visibilityDisabled,
      HTTP_STATUS.UNPROCESSABLE
    );

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
      !withinScope(actor, row.uploadedBy) ||
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
      replace: objectHeaders(
        {
          mimeType: row.mimeType,
          kind: row.kind,
          filename: downloadFilename(row),
        },
        to
      ),
    });
    const target = await headObjectInR2({ key: row.r2Key, bucketType: to });
    if (
      !target ||
      target.contentLength !== row.sizeBytes ||
      target.etag !== source.etag
    )
      throw new Error('copied object does not match its source');
  } catch (error) {
    logSanitized('error', {
      msg: 'media.transition copy failed',
      errorClass: errorTypeOf(error),
    });
    const reverted = await removeStaleCopy(id, row.r2Key, to, transitionToken);
    if (!reverted.removed)
      logSanitized('error', {
        msg: 'media.transition revert left to the sweep',
        id,
      });
    throw new CustomError(mediaMsg.storeFailed, HTTP_STATUS.INTERNAL_ERROR);
  }

  const flipped = await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({ bucketType: to, transition: 'cleanup' })
      // On the token, not the marker value `retryTransitions` also writes on
      // takeover: a value match could flip onto the object its sweep is deleting.
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

  // The sweep reverted this saga mid-copy; nothing else will remove the copy
  // that has since landed.
  if (!flipped) {
    await removeStaleCopy(id, row.r2Key, to, transitionToken);
    throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
  }

  const cleaned = await removeStaleCopy(id, row.r2Key, from, transitionToken);
  return cleaned.row ?? flipped;
}

/**
 * Reverts `to_*` rows (never flipped, so nobody holds the new URL) and finishes
 * `cleanup` rows a crashed request left behind. Safe to repeat: R2 deletes a
 * missing key as 204.
 *
 * `hasMore` is backlog, not failure; the retention job signals them differently.
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
    .where(and(isNotNull(files.transition), staleTransition()))
    .limit(TRANSITION_RETRY_BATCH);

  let reverted = 0;
  let finished = 0;
  let failed = 0;
  for (const row of stuck) {
    // Unreachable under `chk_files_transition_owner`; counted as a failure
    // because a tokenless marker can never be claimed.
    if (!row.transition || !row.transitionId) {
      logSanitized('error', {
        msg: 'media.transition sweep found a saga with no owner token',
        id: row.id,
      });
      failed += 1;
      continue;
    }

    // Claimed on the token before any R2 call, so a slow-but-alive owner's flip
    // fails its guard; re-checked stale so a saga started since the read is kept.
    const claim = generateUuidV7();
    const [claimed] = await db
      .update(files)
      .set({ transitionId: claim })
      .where(
        and(
          eq(files.id, row.id),
          eq(files.transitionId, row.transitionId),
          staleTransition()
        )
      )
      .returning({ id: files.id });
    if (!claimed) continue;

    // Opposite the row's bucket either way: the stale source after a flip, the
    // unverified target before one.
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
