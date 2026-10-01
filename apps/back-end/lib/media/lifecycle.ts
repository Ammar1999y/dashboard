import type { Actor, AuditActor } from './actor';
import type { FolderDeleteOutcome } from './folders';
import type { Tx } from '@/db';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { isForeignKeyViolation } from '@/db/errors';
import { files, folders as foldersTable } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { FOLDER_RECURSIVE_DELETE_MAX } from '@app/shared/validation/constants';

import { purgeUrls } from '@/lib/cloudflare/purge';
import {
  deleteObjectsFromR2,
  ENABLED_VISIBILITIES,
  getPublicUrl,
  hasPublicUrl,
} from '@/lib/r2/client';

import { logSanitized } from '@/utils/log';

import { auditAs, withinScope } from './actor';
import { distinctIds, governedIds } from './files';
import { lockFolderFor, lockTree, rowCount, subtreeFolders } from './folders';
import { mediaMsg } from './messages';
import { unreferenced, usedBy } from './usages';

/**
 * Must cover an entity form left open overnight: lowering it deletes uploads
 * out from under the open form. Also reaps a library upload whose activation
 * never ran or whose object write failed ambiguously.
 */
const PENDING_FILE_TTL = '24 hours';

const SWEEP_BATCH_SIZE = 1000;

/**
 * Counted from the pass that first saw the file unfiled (`unfiled_at`), because
 * the owner deletion that orphans it touches no row here. The `unfiled` listing
 * exposes this number.
 */
export const UNFILED_RETENTION_DAYS = 7;
/** Reaped per pass: each one is a statement and an object delete. */
const UNFILED_REAP_BATCH = 100;

/**
 * Shared by the listing, the stamp and the reaper so they agree on which rows
 * are on the clock. Matches nothing until a project registers its owner tables
 * (`unreferenced()` fails closed).
 */
export const unfiledNow = () =>
  and(eq(files.status, 'active'), isNull(files.folderId), unreferenced());

/**
 * Attaches pending uploads to their owner, in the owner's transaction;
 * `attachFiles` in `./link.ts` is the usual way in. The caller inserts its
 * referrer rows AFTER this: the composite FK needs the status flip.
 */
export async function claimFiles(
  tx: Tx,
  params: { ids: readonly EntityID[]; actor: AuditActor }
): Promise<EntityID[]> {
  const ids = distinctIds(params.ids);
  if (ids.length === 0) return [];
  const { actor } = params;
  const claimed = await tx
    .update(files)
    .set({ status: 'active' })
    .where(
      and(
        inArray(files.id, ids),
        eq(files.status, 'pending'),
        eq(files.uploadedBy, actor.userId)
      )
    )
    .returning({ id: files.id });
  if (claimed.length !== ids.length)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.UNPROCESSABLE);

  for (const row of claimed)
    await auditAs(tx, actor, {
      action: 'UPDATE',
      tableName: 'files',
      recordId: row.id,
      oldData: { status: 'pending' },
      newData: { status: 'active' },
    });
  return claimed.map((row) => row.id);
}

interface DoomedRow {
  id: string;
  r2Key: string;
  bucketType: BucketType;
}

/**
 * Objects first, then rows, for rows already `deleting`; a re-run is clean
 * because `DeleteObjects` reports a missing key as deleted. A row is retained
 * while any delete or configured purge it needs failed: a copy still served
 * from the edge is not gone.
 *
 * ⚠️ EVERY enabled bucket, not the one the row names: a transition lost to the
 * sweep can leave a copy opposite that only this row still names. Safe blind,
 * since `ux_files_r2_key` gives one key one row.
 * ⚠️ A row whose own bucket is not configured is retained: its objects are
 * still stored.
 */
async function finishDeleting(
  rows: readonly DoomedRow[]
): Promise<{ removed: string[]; retained: string[] }> {
  if (rows.length === 0) return { removed: [], retained: [] };
  const keys = rows.map((row) => row.r2Key);

  const goneFrom = new Map<BucketType, ReadonlySet<string>>();
  for (const bucketType of ENABLED_VISIBILITIES) {
    try {
      const outcome = await deleteObjectsFromR2({ keys, bucketType });
      goneFrom.set(bucketType, new Set(outcome.deleted));
    } catch {
      // Count only. A key is a row id, but the error text is provider-controlled.
      logSanitized('error', {
        msg: 'media.delete objects failed',
        bucketType,
        count: keys.length,
      });
      goneFrom.set(bucketType, new Set());
    }
  }

  const unpurged = new Set<string>();
  const publicGone = goneFrom.get('public');
  if (publicGone && hasPublicUrl()) {
    const urls = rows
      .filter((row) => publicGone.has(row.r2Key))
      .map((row) => getPublicUrl(row.r2Key));
    const purge = await purgeUrls(urls);
    for (const url of purge.failed) unpurged.add(url);
  }

  const cleared = goneFrom.values().toArray();
  const addressable = (row: DoomedRow) =>
    ENABLED_VISIBILITIES.has(row.bucketType);
  const stranded = rows.filter((row) => !addressable(row));
  if (stranded.length > 0)
    logSanitized('error', {
      msg: 'media.delete row names a bucket this deployment cannot address',
      buckets: [...new Set(stranded.map((row) => row.bucketType))],
      count: stranded.length,
    });

  const done = rows.filter(
    (row) =>
      addressable(row) &&
      cleared.every((gone) => gone.has(row.r2Key)) &&
      !(hasPublicUrl() && unpurged.has(getPublicUrl(row.r2Key)))
  );

  const settled = new Set(done.map((row) => row.id));
  const retained = rows
    .filter((row) => !settled.has(row.id))
    .map((row) => row.id);
  if (done.length === 0) return { removed: [], retained };

  const deletedRows = await db
    .delete(files)
    .where(
      and(
        inArray(
          files.id,
          done.map((row) => row.id)
        ),
        eq(files.status, 'deleting')
      )
    )
    .returning({ id: files.id });
  return { removed: deletedRows.map((row) => row.id), retained };
}

/**
 * Marking `deleting` is the only transaction, and the composite FK refuses it
 * on a referenced row before any byte is lost. Objects and rows are removed
 * after it with no transaction open (`db/limits.ts`).
 *
 * `pending` is what the store or a purge has not honoured yet: already
 * invisible, and finished by the sweep.
 */
export async function deleteFiles(params: {
  ids: readonly EntityID[];
  actor: Actor;
  /** Pages the actor may `view`, for naming the owners in a refusal. */
  viewable: ReadonlySet<DashboardPage>;
  /**
   * Only owner code removing its own record's files sets this, so the library
   * cannot delete a file an owner still holds (`mediaGoverned`).
   */
  authorizedByOwner?: boolean;
}): Promise<{ deleted: EntityID[]; pending: EntityID[] }> {
  const ids = distinctIds(params.ids);
  const { actor } = params;

  let doomed: DoomedRow[];
  try {
    doomed = await withTransaction(async (tx) => {
      const rows = await tx
        .select({
          id: files.id,
          r2Key: files.r2Key,
          bucketType: files.bucketType,
          status: files.status,
          transition: files.transition,
          uploadedBy: files.uploadedBy,
          displayName: files.displayName,
          folderId: files.folderId,
        })
        .from(files)
        .where(inArray(files.id, ids))
        .for('update');
      const governed = await governedIds(tx, ids);

      const visible = rows.filter(
        (row) =>
          withinScope(actor, row.uploadedBy) &&
          (params.authorizedByOwner === true || governed.has(row.id))
      );
      if (visible.length !== ids.length)
        throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
      // The sagas must not interleave, and deleting a `pending` row lets its
      // upload's PUT write an object nothing owns.
      if (visible.some((row) => row.status !== 'active' || row.transition))
        throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);

      await tx
        .update(files)
        .set({ status: 'deleting' })
        .where(inArray(files.id, ids));

      for (const row of visible)
        await auditAs(tx, actor, {
          action: 'DELETE',
          tableName: 'files',
          recordId: row.id,
          oldData: {
            displayName: row.displayName,
            folderId: row.folderId,
            bucketType: row.bucketType,
            key: row.r2Key,
          },
        });

      return visible.map((row) => ({
        id: row.id,
        r2Key: row.r2Key,
        bucketType: row.bucketType,
      }));
    });
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    const summaries = await usedBy(ids, params.viewable);
    const labels = new Set<string>();
    let hidden = 0;
    for (const summary of summaries.values()) {
      for (const usage of summary.visible) labels.add(usage.label);
      hidden += summary.hidden;
    }
    throw new CustomError(
      labels.size > 0 || hidden > 0
        ? mediaMsg.fileInUseBy([...labels], hidden)
        : mediaMsg.fileInUse,
      HTTP_STATUS.CONFLICT
    );
  }

  const { removed, retained } = await finishDeleting(doomed);
  return { deleted: removed, pending: retained };
}

/**
 * Plan under the tree lock, `deleteFiles`, then delete the folders under the
 * lock again: no transaction may stay open across the object store
 * (`db/limits.ts`), and going through `deleteFiles` keeps the composite FK
 * refusing a held file.
 *
 * A tree that changed in between returns `folders: 0` rather than throwing: the
 * files ARE deleted by then, and a retry after the sweep removes the folders.
 *
 * Not in `./folders.ts`, which must not import this module.
 */
export async function deleteFolderTree(params: {
  folderId: EntityID;
  actor: Actor;
  viewable: ReadonlySet<DashboardPage>;
}): Promise<FolderDeleteOutcome> {
  const { folderId, actor } = params;

  const plan = await withTransaction(async (tx) => {
    await lockTree(tx);
    await lockFolderFor(tx, folderId, actor);
    const tree = await subtreeFolders(tx, folderId);
    // `own` narrows the whole subtree, not only its root.
    if (tree.some((folder) => !withinScope(actor, folder.createdBy)))
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

    const contents = await tx
      .select({
        id: files.id,
        status: files.status,
        uploadedBy: files.uploadedBy,
      })
      .from(files)
      .where(
        inArray(
          files.folderId,
          tree.map((folder) => folder.id)
        )
      );
    // The root is not a descendant of itself.
    if (tree.length - 1 + contents.length > FOLDER_RECURSIVE_DELETE_MAX)
      throw new CustomError(mediaMsg.folderTooLarge, HTTP_STATUS.UNPROCESSABLE);
    // Refused up front: `deleteFiles` cannot delete a non-`active` row, which
    // would strand the folders it sits in.
    if (contents.some((row) => row.status !== 'active'))
      throw new CustomError(mediaMsg.folderBusy, HTTP_STATUS.CONFLICT);
    // `own` reaches the files too, refused while the tree is still intact.
    if (contents.some((row) => !withinScope(actor, row.uploadedBy)))
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    return { tree, fileIds: contents.map((row) => row.id) };
  });

  const removed =
    plan.fileIds.length === 0
      ? { deleted: [], pending: [] }
      : await deleteFiles({
          ids: plan.fileIds,
          actor,
          viewable: params.viewable,
        });

  const folders = await withTransaction(async (tx) => {
    await lockTree(tx);
    const ids = plan.tree.map((folder) => folder.id);
    // The same tree, not one of the same size: a folder created in between is
    // not in the plan, and the FK would refuse deleting its parent.
    const current = await subtreeFolders(tx, folderId);
    const tree = new Set(current.map((folder) => folder.id));
    const [remaining] = await tx
      .select({ count: rowCount() })
      .from(files)
      .where(inArray(files.folderId, ids));
    if (
      tree.size !== ids.length ||
      ids.some((id) => !tree.has(id)) ||
      (remaining?.count ?? 0) > 0
    )
      return 0;

    // One statement: `folders.parent_id` is NO ACTION, checked at its end.
    await tx.delete(foldersTable).where(inArray(foldersTable.id, ids));
    for (const folder of plan.tree)
      await auditAs(tx, actor, {
        action: 'DELETE',
        tableName: 'folders',
        recordId: folder.id,
        oldData: { name: folder.name, parentId: folder.parentId },
      });
    return ids.length;
  });

  return { folders, ...removed };
}

export interface FileSweepCount {
  removed: number;
  unfiled: { stamped: number; reaped: number };
  hasMore: boolean;
  degraded: boolean;
}

/** Two statements, so the stamp can use `unfiledNow()` itself. */
async function stampUnfiled(): Promise<number> {
  await db
    .update(files)
    .set({ unfiledAt: null })
    .where(
      sql`${files.unfiledAt} is not null and not (${files.folderId} is null and (${unreferenced()}))`
    );
  const stamped = await db
    .update(files)
    .set({ unfiledAt: sql`now()` })
    .where(and(unfiledNow(), isNull(files.unfiledAt)))
    .returning({ id: files.id });
  return stamped.length;
}

/**
 * One statement per row, so an FK refusal leaves its neighbours marked. A
 * refusal means a referrer missing from the registry, which
 * `tests/integration/media-usages.test.ts` exists to catch.
 */
async function reapUnfiled(): Promise<{
  reaped: number;
  refused: number;
  hasMore: boolean;
}> {
  const cutoff = sql`now() - ${`${UNFILED_RETENTION_DAYS} days`}::interval`;
  const due = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(unfiledNow(), isNull(files.transition), lt(files.unfiledAt, cutoff))
    )
    .limit(UNFILED_REAP_BATCH);

  let reaped = 0;
  let refused = 0;
  for (const { id } of due) {
    try {
      const marked = await db
        .update(files)
        .set({ status: 'deleting' })
        .where(
          and(
            eq(files.id, id),
            unfiledNow(),
            isNull(files.transition),
            lt(files.unfiledAt, cutoff)
          )
        )
        .returning({ id: files.id });
      reaped += marked.length;
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      refused += 1;
    }
  }
  if (refused > 0)
    logSanitized('error', {
      msg: 'media.unfiled reap refused by an unregistered referrer',
      count: refused,
    });
  return { reaped, refused, hasMore: due.length === UNFILED_REAP_BATCH };
}

/**
 * `degraded` is only a retained row or a refused reap, so the job can tell a
 * store outage from an ordinary backlog (`hasMore`).
 */
export async function sweepFiles(): Promise<FileSweepCount> {
  const expiredBefore = sql`now() - ${PENDING_FILE_TTL}::interval`;
  const expired = () =>
    and(
      eq(files.status, 'pending'),
      isNull(files.transition),
      lt(files.createdAt, expiredBefore)
    );
  const marked = await withTransaction(async (tx) => {
    const candidates = tx
      .select({ id: files.id })
      .from(files)
      .where(expired())
      .limit(SWEEP_BATCH_SIZE);
    // A `pending` row can have no referrer, so marking it cannot hit the
    // composite FK. Repeated on the UPDATE: under Read Committed only the outer
    // WHERE is re-checked against a row a racing claim just made active, so
    // without it the sweep marks a referenced file and throws on the FK.
    return tx
      .update(files)
      .set({ status: 'deleting' })
      .where(and(inArray(files.id, candidates), expired()))
      .returning({ id: files.id });
  });

  const stamped = await stampUnfiled();
  const reap = await reapUnfiled();

  const doomed = await db
    .select({ id: files.id, r2Key: files.r2Key, bucketType: files.bucketType })
    .from(files)
    .where(eq(files.status, 'deleting'))
    .limit(SWEEP_BATCH_SIZE);

  const { removed, retained } = await finishDeleting(doomed);
  return {
    removed: removed.length,
    unfiled: { stamped, reaped: reap.reaped },
    hasMore:
      marked.length === SWEEP_BATCH_SIZE ||
      doomed.length === SWEEP_BATCH_SIZE ||
      reap.hasMore ||
      retained.length > 0,
    degraded: retained.length > 0 || reap.refused > 0,
  };
}
