import type { Actor } from './actor';
import type { MediaFileRow } from './files';
import type { PassBudget } from './orphaned-objects';
import type { FileTransition } from '@/db/schema';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files } from '@/db/schema';

import { mediaMsg } from '@app/shared/messages/media';

import { PURGE_BATCH_SIZE } from '@/lib/cloudflare/purge';
import { serverFault } from '@/lib/http/response';
import { generateUuidV7 } from '@/lib/id';
import {
  copyFileInR2,
  headObjectInR2,
  isVisibilityEnabled,
} from '@/lib/r2/client';

import { errorTypeOf, logSanitized } from '@/utils/log';

import { auditAs, withinScope } from './actor';
import {
  fileBusy,
  fileNotFound,
  unpublishInUse,
  visibilityDisabled,
} from './errors';
import {
  ABANDONED_AFTER,
  downloadFilename,
  FILE_COLUMNS,
  governedIds,
  matchesRow,
} from './files';
import { objectHeaders } from './headers';
import {
  deleteStoredObject,
  evictedFromEdge,
  logPassStopped,
  passBudget,
  removeOrphanedObject,
} from './orphaned-objects';
import { hasPublicUsage } from './usages';

/** Past this a set marker is abandoned and the sweep takes it over. */
const staleTransition = () =>
  lt(files.updatedAt, sql`now() - ${ABANDONED_AFTER}::interval`);

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

interface StaleCopy {
  fileId: EntityID;
  key: string;
  /** The bucket the row does NOT name. */
  bucketType: BucketType;
  token: string;
}

/** The claim was refused: the row is gone, or another attempt owns it. */
async function unclaimedCopy(
  copy: StaleCopy,
  budget?: PassBudget
): Promise<CleanupOutcome> {
  const [live] = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.id, copy.fileId));
  if (!live) {
    logSanitized('error', {
      msg: 'media.transition stale copy outlived its row',
      id: copy.fileId,
    });
    return {
      removed: await removeOrphanedObject(copy.key, copy.bucketType, budget),
      row: null,
    };
  }
  // The owning attempt now holds the demand, or the object here is live.
  logSanitized('error', {
    msg: 'media.transition stale copy handed to the transition that owns the row',
    id: copy.fileId,
  });
  return { removed: false, row: null };
}

/**
 * Deletes each copy in the bucket its row does NOT name, the only object this
 * module may delete, and clears the marker. Every abandoned copy comes here.
 * A round claims and deletes copy by copy, purges what it deleted in one go,
 * then clears each marker on the claim it took.
 *
 * R2 has no conditional delete, so only the transition token keeps that bucket
 * from becoming live mid-delete: one R2 delete (`R2_REQUEST_TIMEOUT_MS` ×
 * `maxAttempts`) must stay well inside `ABANDONED_AFTER`, which is why each
 * claim is taken right before its own delete.
 *
 * ⚠️ A copy landing during the delete bumps `cleanup_requests`, which refuses
 * the clear and sends that copy round again.
 * ⚠️ A missing row proves the key dead (it embeds the primary key and
 * `ux_files_r2_key` is unique); nothing else names it, so the copy goes to
 * `removeOrphanedObject`.
 *
 * `null` for a copy a spent `budget` never reached; its marker is untouched.
 */
async function removeStaleCopies(
  copies: readonly StaleCopy[],
  budget?: PassBudget
): Promise<(CleanupOutcome | null)[]> {
  const outcomes: (CleanupOutcome | null)[] = copies.map(() => null);
  let open = copies.map((copy, index) => ({ ...copy, index }));
  for (let round = 0; round < CLEANUP_ROUNDS && open.length > 0; round++)
    open = await cleanupRound(open, outcomes, budget);
  return outcomes;
}

type OpenCopy = StaleCopy & { index: number };

/** Writes each copy's outcome; answers the copies whose clear was refused. */
async function cleanupRound(
  open: readonly OpenCopy[],
  outcomes: (CleanupOutcome | null)[],
  budget: PassBudget | undefined
): Promise<OpenCopy[]> {
  const deleted = await claimAndDelete(open, outcomes, budget);
  const evicted = await evictedFromEdge(deleted);
  const refused: OpenCopy[] = [];
  for (const [position, copy] of deleted.entries()) {
    if (!evicted[position]) continue;
    const [settled] = await db
      .update(files)
      .set({ transition: null, transitionId: null })
      .where(
        and(
          eq(files.id, copy.fileId),
          eq(files.transitionId, copy.token),
          eq(files.cleanupRequests, copy.requests)
        )
      )
      .returning(FILE_COLUMNS);
    if (settled) outcomes[copy.index] = { removed: true, row: settled };
    else refused.push(copy);
  }
  return refused;
}

/** The copies gone from the store, each with the claim its clear must match. */
async function claimAndDelete(
  open: readonly OpenCopy[],
  outcomes: (CleanupOutcome | null)[],
  budget: PassBudget | undefined
): Promise<(OpenCopy & { requests: number })[]> {
  const deleted: (OpenCopy & { requests: number })[] = [];
  for (const copy of open) {
    if (budget?.spent()) break;
    outcomes[copy.index] = { removed: false, row: null };
    const owned = await claimCleanup(copy.fileId, copy.bucketType, copy.token);
    if (!owned) {
      outcomes[copy.index] = await unclaimedCopy(copy, budget);
      continue;
    }
    // A failure leaves the marker set for the sweep, which deletes this bucket.
    if (await deleteStoredObject(copy, budget))
      deleted.push({ ...copy, token: owned.token, requests: owned.requests });
  }
  return deleted;
}

async function removeStaleCopy(
  fileId: EntityID,
  key: string,
  bucketType: BucketType,
  token: string
): Promise<CleanupOutcome> {
  const [outcome] = await removeStaleCopies([
    { fileId, key, bucketType, token },
  ]);
  return outcome ?? { removed: false, row: null };
}

/**
 * Copies the object to the other bucket under the same key and flips the row
 * once the copy is verified; no transaction stays open across the object store.
 * Equal ETags prove equal bytes: R2's single-part ETag is the content MD5, and
 * a copy's result carries the new object's (measured), so the source HEAD that
 * checked the row's length vouches for the copy's too.
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
  if (!isVisibilityEnabled(to)) throw visibilityDisabled();

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
      throw fileNotFound();
    if (row.status !== 'active' || row.transition) throw fileBusy([id]);
    if (row.bucketType === to) return { row, done: true as const };
    if (to === 'private' && (await hasPublicUsage(id, tx)))
      throw unpublishInUse();

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
    const copy = await copyFileInR2({
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
    if (copy.etag === null || copy.etag !== source.etag)
      throw new Error('copied object does not match its source');
  } catch (error) {
    const failure = {
      msg: 'media.transition copy failed',
      errorClass: errorTypeOf(error),
      id,
    };
    const reverted = await removeStaleCopy(
      id,
      row.r2Key,
      to,
      transitionToken
    ).catch((revertError: unknown) => {
      throw serverFault(mediaMsg.storeFailed, { ...failure, revertError });
    });
    throw serverFault(mediaMsg.storeFailed, {
      ...failure,
      revert: reverted.removed ? 'done' : 'left to the sweep',
    });
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
    throw fileBusy([id]);
  }

  const cleaned = await removeStaleCopy(id, row.r2Key, from, transitionToken);
  return cleaned.row ?? flipped;
}

interface StuckRow {
  id: EntityID;
  r2Key: string;
  bucketType: BucketType;
  transition: FileTransition | null;
  transitionId: string | null;
}

/**
 * Takes over each stale saga in `rows` before any R2 call, so a slow-but-alive
 * owner's flip fails its guard; re-checked stale so a saga started since the
 * read is kept.
 */
async function claimStale(
  rows: readonly StuckRow[],
  budget: PassBudget
): Promise<{
  claimed: (StaleCopy & { transition: FileTransition })[];
  reached: number;
  tokenless: number;
}> {
  const claimed: (StaleCopy & { transition: FileTransition })[] = [];
  let reached = 0;
  let tokenless = 0;
  for (const row of rows) {
    if (budget.spent()) break;
    reached += 1;
    // Unreachable under `chk_files_transition_owner`; counted as a failure
    // because a tokenless marker can never be claimed.
    if (!row.transition || !row.transitionId) {
      logSanitized('error', {
        msg: 'media.transition sweep found a saga with no owner token',
        id: row.id,
      });
      tokenless += 1;
      continue;
    }

    const claim = generateUuidV7();
    const [taken] = await db
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
    if (!taken) continue;

    // Opposite the row's bucket either way: the stale source after a flip,
    // the unverified target before one.
    claimed.push({
      fileId: row.id,
      key: row.r2Key,
      bucketType: other(row.bucketType),
      token: claim,
      transition: row.transition,
    });
  }
  return { claimed, reached, tokenless };
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

  const budget = passBudget();
  let reverted = 0;
  let finished = 0;
  let failed = 0;
  let reached = 0;
  let unreached = 0;
  // A chunk shares one purge call, and bounds how long a deleted copy waits
  // for its marker to clear.
  for (let start = 0; start < stuck.length; start += PURGE_BATCH_SIZE) {
    if (budget.spent()) break;
    const chunk = stuck.slice(start, start + PURGE_BATCH_SIZE);
    const taken = await claimStale(chunk, budget);
    reached += taken.reached;
    failed += taken.tokenless;

    const cleaned = await removeStaleCopies(taken.claimed, budget);
    for (const [index, copy] of taken.claimed.entries()) {
      const outcome = cleaned[index];
      // Claimed but never reached: the marker stays, stale again by the next
      // run.
      if (!outcome) unreached += 1;
      else if (!outcome.removed) failed += 1;
      else if (copy.transition === 'cleanup') finished += 1;
      else reverted += 1;
    }
  }
  const left = stuck.length - reached + unreached;
  const stop = budget.spent();
  if (stop && left > 0) logPassStopped('transitions', stop, left);
  return {
    reverted,
    finished,
    failed,
    hasMore: stuck.length === TRANSITION_RETRY_BATCH || left > 0,
  };
}
