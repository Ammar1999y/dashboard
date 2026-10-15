/**
 * Operations on a selection of files and folders together: the move and the
 * delete, which share how a selection is read, and the delete's preview.
 *
 * Lock order, for every writer that touches files or folders (deadlock-free
 * only while all of them keep it): `lockTree` first for any structural writer;
 * rows of one table in `id` order; a move takes its folders `FOR NO KEY UPDATE`
 * before its files `FOR UPDATE`; a delete takes its files before its folders,
 * in the order `updateFile` takes a file and then its destination's `KEY SHARE`.
 */
import type { Actor } from './actor';
import type { DoomedRow } from './lifecycle';
import type { Executor, Tx } from '@/db';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type {
  deletePreviewSchema,
  movedSelectionSchema,
} from '@app/shared/responses/media';
import type { EntityID } from '@app/shared/types';
import type { BucketType } from '@app/shared/validation/enums';

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { isForeignKeyViolation, isLockNotAvailable } from '@/db/errors';
import { files, folders } from '@/db/schema';
import * as z from 'zod';

import { mediaMsg } from '@app/shared/messages/media';
import {
  FOLDER_MAX_DEPTH,
  FOLDER_RECURSIVE_DELETE_MAX,
} from '@app/shared/validation/constants';

import { auditAs, withinScope } from './actor';
import {
  fileBusy,
  fileInUse,
  fileNotFound,
  folderBusy,
  folderNotEmpty,
  folderNotFound,
  selectionTooLarge,
} from './errors';
import {
  ABANDONED_AFTER,
  filedInto,
  lockFilesForEdit,
  mediaGoverned,
} from './files';
import {
  assertNamesFree,
  folderNameConflict,
  lockTree,
  prepareFolderMove,
} from './folders';
import { distinctIds, idRowSchema, sortedIds, uuidList } from './ids';
import { finishDeleting } from './lifecycle';
import { usageLabels, usedIds } from './usages';

/**
 * Per user per minute, one budget for every route that runs the operation, so
 * a deprecated route or the single-folder delete adds none of its own.
 */
export const MOVE_LIMIT = { scope: 'media.move', limit: 30 } as const;
export const DELETE_LIMIT = { scope: 'media.delete', limit: 30 } as const;

interface DeleteOutcome {
  folders: number;
  folderIds: EntityID[];
  deleted: EntityID[];
  pending: EntityID[];
}
type DeletePreview = z.input<typeof deletePreviewSchema>;
type MovedSelection = z.input<typeof movedSelectionSchema>;

interface Selection {
  fileIds: readonly EntityID[];
  folderIds: readonly EntityID[];
}

const ids = (rows: readonly { id: EntityID }[]) => rows.map((row) => row.id);

/** The marking refused by an owner's key; answered once the transaction is gone. */
class FileReferencedError extends Error {
  constructor(options: ErrorOptions) {
    super('a file to delete is referenced by an owner record', options);
    this.name = 'FileReferencedError';
  }
}

const coveredRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['file', 'folder']),
});

/**
 * Drops every selected item a selected folder already contains, at any depth:
 * acting on the folder acts on it. Advisory, read before any row lock; what is
 * actually inside is re-read once the locks are held.
 */
async function normalizeSelection(
  executor: Executor,
  selection: Selection
): Promise<Selection> {
  const fileIds = distinctIds(selection.fileIds);
  const folderIds = distinctIds(selection.folderIds);
  if (folderIds.length === 0) return { fileIds, folderIds };

  const starts = [
    sql`select f.id, 'folder'::text as kind, f.parent_id as node from folders f where f.id in (${uuidList(folderIds)})`,
    ...(fileIds.length > 0
      ? [
          sql`select x.id, 'file'::text as kind, x.folder_id as node from files x where x.id in (${uuidList(fileIds)})`,
        ]
      : []),
  ];
  const rows = await executor.execute(sql`
    with recursive start as (${sql.join(starts, sql` union all `)}),
    up as (
      select id, kind, node, 1 as depth from start where node is not null
      union all
      select up.id, up.kind, f.parent_id, up.depth + 1
      from folders f join up on f.id = up.node
      where f.parent_id is not null and up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select distinct id::text as id, kind from up
    where node in (${uuidList(folderIds)})
  `);
  const covered = new Set(rows.map((row) => coveredRowSchema.parse(row).id));
  return {
    fileIds: fileIds.filter((id) => !covered.has(id)),
    folderIds: folderIds.filter((id) => !covered.has(id)),
  };
}

/**
 * Moves files and folders under one destination in one transaction: every
 * item moves, or nothing does. Answers the ids actually re-parented; an item
 * already there, or inside a selected folder, is not among them.
 */
export async function moveSelection(
  params: Selection & { to: EntityID | null; actor: Actor }
): Promise<MovedSelection> {
  const { to, actor } = params;
  const moved: { folderIds: EntityID[] } = { folderIds: [] };
  try {
    return await withTransaction(async (tx) => {
      await lockTree(tx);
      const selection = await normalizeSelection(tx, params);
      if (to === null && selection.fileIds.length > 0)
        throw new Error('moveSelection: files cannot move to the root');

      const { moving } = await prepareFolderMove(tx, {
        folderIds: selection.folderIds,
        to,
        actor,
      });
      moved.folderIds = moving.map((folder) => folder.id);
      await assertNamesFree(tx, moved.folderIds, to);

      const lockedFiles =
        to === null || selection.fileIds.length === 0
          ? []
          : await lockFilesForEdit(tx, selection.fileIds, actor);
      const movingFiles = lockedFiles.filter((file) => file.folderId !== to);

      // Every selected row is written, moved or already there, as the
      // file-only route always did: the answer's timestamp is then what each
      // of them stores.
      const writtenFolders =
        selection.folderIds.length === 0
          ? []
          : await tx
              .update(folders)
              .set({ parentId: to })
              .where(inArray(folders.id, selection.folderIds))
              .returning({ updatedAt: folders.updatedAt });
      const writtenFiles =
        to === null || lockedFiles.length === 0
          ? []
          : await tx
              .update(files)
              .set(filedInto(to))
              .where(inArray(files.id, ids(lockedFiles)))
              .returning({ updatedAt: files.updatedAt });
      const [written] = [...writtenFolders, ...writtenFiles];
      if (!written) throw new Error('moveSelection wrote no row');

      for (const folder of moving)
        await auditAs(tx, actor, {
          action: 'UPDATE',
          tableName: 'folders',
          recordId: folder.id,
          oldData: { parentId: folder.parentId },
          newData: { parentId: to },
        });
      for (const file of movingFiles)
        await auditAs(tx, actor, {
          action: 'UPDATE',
          tableName: 'files',
          recordId: file.id,
          oldData: { folderId: file.folderId },
          newData: { folderId: to },
        });

      return {
        fileIds: sortedIds(ids(movingFiles)),
        folderIds: sortedIds(moved.folderIds),
        unfiledAt: null,
        updatedAt: written.updatedAt.toISOString(),
      };
    });
  } catch (error) {
    throw folderNameConflict(error, moved.folderIds) ?? error;
  }
}

interface DeleteRequest extends Selection {
  /** Reach inside the selected folders; without it they must be empty. */
  recursive: boolean;
  actor: Actor;
  /** Pages the actor may `view`, for naming the owners in a refusal. */
  viewable: ReadonlySet<DashboardPage>;
  /**
   * Only owner code removing its own record's files sets this, so the library
   * cannot delete a file an owner still holds (`mediaGoverned`).
   */
  authorizedByOwner?: boolean;
}

interface SurveyedFolder {
  id: EntityID;
  name: string;
  parentId: EntityID | null;
  createdBy: EntityID | null;
}

interface SurveyedFile {
  id: EntityID;
  r2Key: string;
  bucketType: BucketType;
  status: 'pending' | 'active' | 'deleting';
  transition: string | null;
  folderId: EntityID | null;
  uploadedBy: EntityID | null;
  displayName: string;
  /** A `pending` row whose request cannot still be running (`ABANDONED_AFTER`). */
  abandoned: boolean;
  governed: boolean;
}

/** What one read of the selection found. Bounded: never more than the cap plus one of either kind. */
interface Survey {
  selectedFolders: SurveyedFolder[];
  /** Below the selected folders; read only for a recursive delete. */
  descendants: SurveyedFolder[];
  /** Without `recursive`: selected folders holding a subfolder or an active file. */
  occupied: EntityID[];
  selectedFiles: SurveyedFile[];
  /**
   * Inside the folders to delete, in any state but `deleting`; without
   * `recursive`, only the uploads, since anything active refuses it.
   */
  contents: SurveyedFile[];
  missingFolder: boolean;
  missingFile: boolean;
}

const LIMIT = FOLDER_RECURSIVE_DELETE_MAX;

const SURVEY_FOLDER_COLUMNS = {
  id: folders.id,
  name: folders.name,
  parentId: folders.parentId,
  createdBy: folders.createdBy,
} as const;

const SURVEY_FILE_COLUMNS = {
  id: files.id,
  r2Key: files.r2Key,
  bucketType: files.bucketType,
  status: files.status,
  transition: files.transition,
  folderId: files.folderId,
  uploadedBy: files.uploadedBy,
  displayName: files.displayName,
  abandoned: sql<boolean>`(${files.status} = 'pending' and ${files.createdAt} < now() - ${ABANDONED_AFTER}::interval)`,
} as const;

/**
 * Every descendant id, breadth first, at most `limit`. The outer query neither
 * sorts nor joins the recursive term, which is what lets PostgreSQL stop it at
 * the limit instead of walking the whole subtree.
 */
async function descendantIds(
  executor: Executor,
  rootIds: readonly EntityID[],
  limit: number
): Promise<EntityID[]> {
  const rows = await executor.execute(sql`
    with recursive down as (
      select id, 1 as level from folders where parent_id in (${uuidList(rootIds)})
      union all
      select f.id, down.level + 1
      from folders f join down on f.parent_id = down.id
      where down.level < ${FOLDER_MAX_DEPTH}
    )
    select id::text as id from down limit ${limit}
  `);
  return rows.map((row) => idRowSchema.parse(row).id);
}

/** The selected folders holding a subfolder or an active file: one row per folder at most. */
async function occupiedFolders(
  executor: Executor,
  folderIds: readonly EntityID[]
): Promise<EntityID[]> {
  const rows = await executor.execute(sql`
    select id::text as id from folders f
    where f.id in (${uuidList(folderIds)})
      and (exists (select 1 from folders child where child.parent_id = f.id)
        or exists (select 1 from files held where held.folder_id = f.id and held.status = 'active'))
  `);
  return rows.map((row) => idRowSchema.parse(row).id);
}

/**
 * Pre-lock it decides what to lock; under the locks, read again, it is the
 * truth. Each statement takes a fresh snapshot, so `mediaGoverned` here sees a
 * claim that committed while the locks were awaited.
 */
async function surveyDelete(
  executor: Executor,
  selection: Selection,
  recursive: boolean
): Promise<Survey> {
  const { fileIds, folderIds } = selection;
  const selectedFolders =
    folderIds.length === 0
      ? []
      : await executor
          .select(SURVEY_FOLDER_COLUMNS)
          .from(folders)
          .where(inArray(folders.id, [...folderIds]));
  const selectedFiles =
    fileIds.length === 0
      ? []
      : await executor
          .select({
            ...SURVEY_FILE_COLUMNS,
            // A `deleting` row is detached and can have no referrer, so it
            // hides no record: a retried delete answers busy whether or not
            // any owner table is registered.
            governed: sql<boolean>`(${mediaGoverned()} or ${files.status} = 'deleting')`,
          })
          .from(files)
          .where(inArray(files.id, [...fileIds]));

  const roots = selectedFolders.map((folder) => folder.id);
  const below =
    recursive && roots.length > 0
      ? await descendantIds(executor, roots, LIMIT + 1)
      : [];
  const descendants =
    below.length === 0
      ? []
      : await executor
          .select(SURVEY_FOLDER_COLUMNS)
          .from(folders)
          .where(inArray(folders.id, below));
  const occupied =
    !recursive && roots.length > 0
      ? await occupiedFolders(executor, roots)
      : [];

  const tree = [...roots, ...below];
  const contents =
    tree.length === 0
      ? []
      : await executor
          .select({ ...SURVEY_FILE_COLUMNS, governed: sql<boolean>`true` })
          .from(files)
          .where(
            and(
              inArray(files.folderId, tree),
              recursive
                ? ne(files.status, 'deleting')
                : eq(files.status, 'pending')
            )
          )
          .limit(LIMIT + 1);

  return {
    selectedFolders,
    descendants,
    occupied,
    selectedFiles,
    contents,
    missingFolder: selectedFolders.length !== folderIds.length,
    missingFile: selectedFiles.length !== fileIds.length,
  };
}

/** What a survey means for the delete, in the order the refusals are checked. */
interface Verdict {
  /** Which kind of item answers 404: absent, or outside the caller's scope. */
  notFound: 'folder' | 'file' | null;
  /** Folders and files that would go, the selected folders included. */
  folderCount: number;
  fileCount: number;
  exceedsLimit: boolean;
  /** Without `recursive`: selected folders holding something that is not an upload. */
  nonEmptyFolderIds: EntityID[];
  busyFileIds: EntityID[];
  /** Folders holding an upload still in flight. */
  unfinishedFolderIds: EntityID[];
  doomedFiles: SurveyedFile[];
  doomedFolders: SurveyedFolder[];
}

function judge(
  survey: Survey,
  request: Pick<DeleteRequest, 'actor' | 'authorizedByOwner'>
): Verdict {
  const { actor } = request;
  const folderHidden = (folder: SurveyedFolder) =>
    !withinScope(actor, folder.createdBy);
  const fileHidden = (file: SurveyedFile) =>
    !withinScope(actor, file.uploadedBy) ||
    (request.authorizedByOwner !== true && !file.governed);

  // A selected file filed into a selected folder after normalisation is read
  // twice, once selected and once contained.
  const selectedIds = new Set(ids(survey.selectedFiles));
  const contents = survey.contents.filter((file) => !selectedIds.has(file.id));

  const notFound =
    survey.missingFolder ||
    survey.selectedFolders.some(folderHidden) ||
    survey.descendants.some(folderHidden)
      ? 'folder'
      : survey.missingFile ||
          survey.selectedFiles.some(fileHidden) ||
          // An upload is listed nowhere, so its uploader's scope protects
          // nothing: a fresh one is busy, an abandoned one goes with its folder.
          contents.some((file) => file.status === 'active' && fileHidden(file))
        ? 'file'
        : null;

  const doomedFiles = [
    ...survey.selectedFiles,
    ...contents.filter((file) => file.status === 'active' || file.abandoned),
  ];
  const doomedFolders = [...survey.selectedFolders, ...survey.descendants];
  const selectedBusy = survey.selectedFiles.filter(
    (file) => file.status !== 'active' || file.transition !== null
  );
  const containedBusy = contents.filter(
    (file) => file.status === 'active' && file.transition !== null
  );

  return {
    notFound,
    folderCount: doomedFolders.length,
    fileCount: doomedFiles.length,
    // A full read means more may lie beyond it.
    exceedsLimit:
      survey.descendants.length + doomedFiles.length > LIMIT ||
      survey.contents.length > LIMIT,
    nonEmptyFolderIds: sortedIds(survey.occupied),
    busyFileIds: sortedIds(ids([...selectedBusy, ...containedBusy])),
    unfinishedFolderIds: sortedIds(
      contents
        .filter((file) => file.status === 'pending' && !file.abandoned)
        .map((file) => file.folderId)
        .filter((id): id is EntityID => id !== null)
    ),
    doomedFiles,
    doomedFolders,
  };
}

/** The refusals before any row lock: scope, the cap, then emptiness. */
function refuseUnlocked(
  verdict: Verdict,
  request: Pick<DeleteRequest, 'recursive' | 'fileIds' | 'folderIds'>
): void {
  if (verdict.notFound === 'folder') throw folderNotFound();
  if (verdict.notFound === 'file') throw fileNotFound();
  // Without `recursive` nothing inside is deleted, so the cap cannot be what
  // stops it: a full folder is refused as full.
  if (!request.recursive && verdict.nonEmptyFolderIds.length > 0)
    throw folderNotEmpty(verdict.nonEmptyFolderIds);
  if (verdict.exceedsLimit)
    throw selectionTooLarge(
      request.folderIds.length === 1 && request.fileIds.length === 0
        ? mediaMsg.folderTooLarge
        : mediaMsg.selectionTooLarge
    );
}

/** The refusals that only a locked read can settle. */
function refuse(
  verdict: Verdict,
  request: Pick<DeleteRequest, 'recursive' | 'fileIds' | 'folderIds'>
): void {
  refuseUnlocked(verdict, request);
  if (verdict.busyFileIds.length > 0) throw fileBusy(verdict.busyFileIds);
  if (verdict.unfinishedFolderIds.length > 0)
    throw folderBusy(verdict.unfinishedFolderIds);
}

/**
 * Locks every file the survey found, in `id` order. A row that was moved out
 * while this waited is left alone by the re-read that follows: only what is
 * still inside, under the folder locks, is deleted.
 */
async function lockFiles(tx: Tx, fileIds: readonly EntityID[]): Promise<void> {
  if (fileIds.length === 0) return;
  await tx
    .select({ id: files.id })
    .from(files)
    .where(inArray(files.id, [...fileIds]))
    .orderBy(asc(files.id))
    .for('update');
}

/**
 * One transaction for the whole selection: the files are marked `deleting`
 * and detached, and the folders deleted, or nothing changes. The objects go
 * after the commit, with no transaction open across the store
 * (`db/limits.ts`); what the store or the purge refuses is already detached,
 * and the sweep finishes it.
 */
export async function deleteSelection(
  request: DeleteRequest
): Promise<DeleteOutcome> {
  const { actor } = request;
  const doomed: { ids: EntityID[] } = { ids: [] };

  let outcome: { rows: DoomedRow[]; folderIds: EntityID[] };
  try {
    outcome = await withTransaction(async (tx) => {
      await lockTree(tx);
      const selection = await normalizeSelection(tx, request);
      const scoped = { ...request, ...selection };
      const surveyed = await surveyDelete(tx, selection, request.recursive);
      const first = judge(surveyed, scoped);
      refuseUnlocked(first, scoped);

      const held = new Set(
        ids([
          ...first.doomedFiles,
          ...surveyed.selectedFiles,
          ...surveyed.contents,
        ])
      );
      await lockFiles(tx, [...held]);
      const folderIds = ids(first.doomedFolders);
      if (folderIds.length > 0)
        await tx
          .select({ id: folders.id })
          .from(folders)
          .where(inArray(folders.id, folderIds))
          .orderBy(asc(folders.id))
          .for('update');

      // Under the folder locks nothing can enter; a file filed in before them
      // is committed, and locked without waiting or refused as busy.
      let survey = await surveyDelete(tx, selection, request.recursive);
      // Before any newcomer lock: one outside the caller's scope is absent,
      // whoever holds it.
      refuseUnlocked(judge(survey, scoped), scoped);
      const newcomers = [...survey.selectedFiles, ...survey.contents]
        .map((file) => file.id)
        .filter((id) => !held.has(id));
      if (newcomers.length > 0) {
        try {
          await tx
            .select({ id: files.id })
            .from(files)
            .where(inArray(files.id, newcomers))
            .orderBy(asc(files.id))
            .for('update', { noWait: true });
        } catch (error) {
          if (isLockNotAvailable(error)) throw fileBusy(newcomers);
          throw error;
        }
        survey = await surveyDelete(tx, selection, request.recursive);
      }
      const verdict = judge(survey, scoped);
      refuse(verdict, scoped);

      doomed.ids = ids(verdict.doomedFiles);
      const treeIds = ids(verdict.doomedFolders);
      let marked: DoomedRow[] = [];
      try {
        if (doomed.ids.length > 0)
          marked = await tx
            .update(files)
            .set({ status: 'deleting', folderId: null })
            .where(inArray(files.id, doomed.ids))
            .returning({
              id: files.id,
              r2Key: files.r2Key,
              bucketType: files.bucketType,
            });
      } catch (error) {
        // Only an owner's composite key can refuse this statement: clearing
        // `folder_id` cannot break the tree's own.
        if (isForeignKeyViolation(error))
          throw new FileReferencedError({ cause: error });
        throw error;
      }
      if (treeIds.length > 0) {
        // Rows marked `deleting` before marking detached them. They let go of
        // the folders here, but the sweep removes their objects, which keeps
        // this request's store work within the cap.
        await tx
          .update(files)
          .set({ folderId: null })
          .where(
            and(inArray(files.folderId, treeIds), eq(files.status, 'deleting'))
          );
        // One statement: `folders.parent_id` is NO ACTION, checked at its end.
        await tx.delete(folders).where(inArray(folders.id, treeIds));
      }

      for (const file of verdict.doomedFiles)
        await auditAs(tx, actor, {
          action: 'DELETE',
          tableName: 'files',
          recordId: file.id,
          oldData: {
            displayName: file.displayName,
            folderId: file.folderId,
            bucketType: file.bucketType,
            key: file.r2Key,
          },
        });
      for (const folder of verdict.doomedFolders)
        await auditAs(tx, actor, {
          action: 'DELETE',
          tableName: 'folders',
          recordId: folder.id,
          oldData: { name: folder.name, parentId: folder.parentId },
        });
      return { rows: marked, folderIds: treeIds };
    });
  } catch (error) {
    if (!(error instanceof FileReferencedError)) throw error;
    // Empty when the referrer is missing from the registry: still in use,
    // but nothing can say by what.
    const used = await usedIds(doomed.ids);
    const { labels, hidden } = await usageLabels([...used], request.viewable);
    throw fileInUse(
      labels.length > 0 || hidden > 0
        ? mediaMsg.fileInUseBy(labels, hidden)
        : mediaMsg.fileInUse,
      used
    );
  }

  const { removed, retained } = await finishDeleting(outcome.rows);
  const requested = new Set(doomed.ids);
  return {
    folders: outcome.folderIds.length,
    folderIds: sortedIds(outcome.folderIds),
    deleted: removed.filter((id) => requested.has(id)),
    pending: retained.filter((id) => requested.has(id)),
  };
}

/** The file-only delete, for the old route and for owner code. */
export async function deleteFiles(params: {
  ids: readonly EntityID[];
  actor: Actor;
  viewable: ReadonlySet<DashboardPage>;
  authorizedByOwner?: boolean;
}): Promise<{ deleted: EntityID[]; pending: EntityID[] }> {
  const { deleted, pending } = await deleteSelection({
    fileIds: params.ids,
    folderIds: [],
    recursive: false,
    actor: params.actor,
    viewable: params.viewable,
    authorizedByOwner: params.authorizedByOwner,
  });
  return { deleted, pending };
}

/**
 * The delete's own reading of the same body, as data instead of refusals, in a
 * read-only snapshot with no lock taken. Advisory: the delete decides again.
 * Above the cap the lists are not computed and are `null`, and the counts are
 * lower bounds.
 */
export async function previewDelete(
  request: Omit<DeleteRequest, 'authorizedByOwner' | 'viewable'>
): Promise<DeletePreview> {
  return withTransaction(
    async (tx) => {
      const selection = await normalizeSelection(tx, request);
      const scoped = { ...request, ...selection };
      const verdict = judge(
        await surveyDelete(tx, selection, request.recursive),
        scoped
      );
      if (verdict.notFound === 'folder') throw folderNotFound();
      if (verdict.notFound === 'file') throw fileNotFound();

      const figures = {
        folders: verdict.folderCount,
        files: verdict.fileCount,
        limit: LIMIT,
      };
      if (verdict.exceedsLimit)
        return {
          ...figures,
          exceedsLimit: true,
          nonEmptyFolderIds: null,
          busyFileIds: null,
          inUseFileIds: null,
          unfinishedFolderIds: null,
        };
      return {
        ...figures,
        exceedsLimit: false,
        nonEmptyFolderIds: verdict.nonEmptyFolderIds,
        busyFileIds: verdict.busyFileIds,
        inUseFileIds: sortedIds(await usedIds(ids(verdict.doomedFiles), tx)),
        unfinishedFolderIds: verdict.unfinishedFolderIds,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}
