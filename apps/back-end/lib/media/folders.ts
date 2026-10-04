import type { Actor } from './actor';
import type { Executor, Tx } from '@/db';
import type { EntityID } from '@app/shared/types';

import { asc, eq, isNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { getConstraintName, isUniqueViolation } from '@/db/errors';
import { files, folders } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
} from '@app/shared/validation/constants';

import { escapeLike } from '@/lib/data-table/filter-columns';

import { auditAs, withinScope } from './actor';

interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One shape for both delete modes; the file half mirrors
 * `DELETE /api/dash/media/files`. `folders: 0` beside deleted files means the
 * tree still held something when its folders were due to go.
 */
export interface FolderDeleteOutcome {
  folders: number;
  deleted: EntityID[];
  pending: EntityID[];
}

interface Breadcrumb {
  id: string;
  name: string;
}

interface FolderHit extends FolderSummary {
  /** Root → the folder itself. */
  breadcrumbs: Breadcrumb[];
}

/**
 * Capped, not paged: a navigation aid beside the paginated file list. The cap
 * is reported (`truncated`) so a dropped folder is never silent.
 */
const FOLDER_SEARCH_LIMIT = 20;

const FOLDER_COLUMNS = {
  id: folders.id,
  name: folders.name,
  parentId: folders.parentId,
  createdBy: folders.createdBy,
  createdAt: folders.createdAt,
  updatedAt: folders.updatedAt,
} as const;

/**
 * A row of a raw statement. The driver types it `Record<string, any>` whatever
 * `execute<T>` is given, so the SQL text is the only statement of its shape.
 */
type RawRow = Awaited<ReturnType<Executor['execute']>>[number];

/** A row selecting `id`, `name`, `parent_id`, `created_by` (ids as text), `created_at`, `updated_at`. */
function toFolderSummary(row: RawRow): FolderSummary {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Direct children of `parentId`; `null` is the root. */
const childrenOf = (parentId: EntityID | null) =>
  parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId);

export const rowCount = () => sql<number>`count(*)::int`;

const FOLDER_UNIQUE_CONSTRAINTS = new Set([
  'ux_folders_parent_name',
  'ux_folders_root_name',
]);

/** A duplicate name is the one constraint a client can correct; anything else is a bug. */
function folderNameConflict(error: unknown): CustomError | null {
  if (!isUniqueViolation(error)) return null;
  return FOLDER_UNIQUE_CONSTRAINTS.has(getConstraintName(error))
    ? new CustomError(mediaMsg.folderNameExists, HTTP_STATUS.CONFLICT)
    : null;
}

/**
 * Row locks cannot stop two disjoint moves (`A` under `B1`, `B` under `A1`)
 * from both committing a cycle, so every structural change takes this lock
 * FIRST, before any row lock. One lock for the whole tree is deliberate:
 * folder mutations are rare. Exported for `./lifecycle.ts`, which this module
 * must not import, or the two form an import cycle.
 */
export async function lockTree(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('media.folders'))`
  );
}

/**
 * Root → leaf. Bounded by the depth cap plus one, so a cycle in the table ends
 * the query rather than the server.
 */
export async function breadcrumbs(
  folderId: EntityID,
  executor: Executor = db
): Promise<Breadcrumb[]> {
  const rows = await executor.execute<{ id: string; name: string }>(sql`
    with recursive up as (
      select id, parent_id, name, 1 as depth
      from folders where id = ${folderId}::uuid
      union all
      select f.id, f.parent_id, f.name, up.depth + 1
      from folders f join up on f.id = up.parent_id
      where up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select id::text as id, name from up order by depth desc
  `);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/** 1 for a root folder. `null` when the folder does not exist. */
async function depthOf(
  executor: Tx,
  folderId: EntityID
): Promise<number | null> {
  const rows = await executor.execute<{ depth: number | string }>(sql`
    with recursive up as (
      select id, parent_id, 1 as depth from folders where id = ${folderId}::uuid
      union all
      select f.id, f.parent_id, up.depth + 1
      from folders f join up on f.id = up.parent_id
      where up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select max(depth) as depth from up
  `);
  const depth = rows[0]?.depth;
  return depth == null ? null : Number(depth);
}

/**
 * Itself included, DEEPEST FIRST: `subtreeOf` reads the height off the first
 * row. Bounded like `breadcrumbs`.
 */
export async function subtreeFolders(
  executor: Tx,
  folderId: EntityID
): Promise<Array<FolderSummary & { level: number }>> {
  const rows = await executor.execute(sql`
    with recursive down as (
      select id, 1 as level from folders where id = ${folderId}::uuid
      union all
      select f.id, down.level + 1
      from folders f join down on f.parent_id = down.id
      where down.level <= ${FOLDER_MAX_DEPTH}
    )
    select f.id::text as id,
           f.name,
           f.parent_id::text as parent_id,
           f.created_by::text as created_by,
           f.created_at,
           f.updated_at,
           down.level
    from down join folders f on f.id = down.id
    order by down.level desc, f.id
  `);
  return rows.map((row) => ({
    ...toFolderSummary(row),
    level: Number(row.level),
  }));
}

/** Every folder under `folderId`, itself included, with the subtree's height. */
async function subtreeOf(
  executor: Tx,
  folderId: EntityID
): Promise<{ ids: Set<string>; height: number }> {
  const rows = await subtreeFolders(executor, folderId);
  return {
    ids: new Set(rows.map((row) => row.id)),
    height: rows[0]?.level ?? 0,
  };
}

/** The fan-out cap on one parent; `null` is the root. Runs under `lockTree`. */
async function assertRoomUnder(
  tx: Tx,
  parentId: EntityID | null
): Promise<void> {
  const [count] = await tx
    .select({ children: rowCount() })
    .from(folders)
    .where(childrenOf(parentId));
  if ((count?.children ?? 0) >= FOLDER_MAX_CHILDREN)
    throw new CustomError(
      mediaMsg.folderTooManyChildren,
      HTTP_STATUS.UNPROCESSABLE
    );
}

/** The prospective parent's depth, with the fan-out cap checked under it. */
async function lockParent(
  tx: Tx,
  parentId: EntityID
): Promise<{ depth: number }> {
  const [parent] = await tx
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, parentId))
    .for('update');
  if (!parent)
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

  const depth = await depthOf(tx, parentId);
  if (depth === null)
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

  await assertRoomUnder(tx, parentId);
  return { depth };
}

export async function lockFolderFor(
  tx: Tx,
  folderId: EntityID,
  actor: Actor
): Promise<FolderSummary> {
  const [folder] = await tx
    .select(FOLDER_COLUMNS)
    .from(folders)
    .where(eq(folders.id, folderId))
    .for('update');
  // Out of scope answers exactly like absent.
  if (!folder || !withinScope(actor, folder.createdBy))
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);
  return folder;
}

export async function requireFolder(
  folderId: EntityID,
  executor: Executor = db
): Promise<void> {
  const [folder] = await executor
    .select(FOLDER_COLUMNS)
    .from(folders)
    .where(eq(folders.id, folderId));
  if (!folder)
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);
}

/** Direct children, by name. Bounded by the cap, which the root shares, so never paginated. */
export async function listSubfolders(
  parentId: EntityID | null
): Promise<FolderSummary[]> {
  return db
    .select(FOLDER_COLUMNS)
    .from(folders)
    .where(childrenOf(parentId))
    .orderBy(asc(sql`lower(${folders.name})`), asc(folders.id))
    .limit(FOLDER_MAX_CHILDREN);
}

/**
 * One statement, so twenty hits do not cost twenty recursive queries. `term`
 * arrives normalised by the data-table parser.
 */
export async function searchFolders(
  term: string
): Promise<{ folders: FolderHit[]; truncated: boolean }> {
  const pattern = `%${escapeLike(term)}%`;
  const rows = await db.execute(sql`
    with recursive hits as (
      select id, name, parent_id, created_by, created_at, updated_at
      from folders
      where name ilike ${pattern}
      order by lower(name), id
      limit ${FOLDER_SEARCH_LIMIT + 1}
    ), up as (
      select h.id as hit, f.id, f.parent_id, f.name, 1 as depth
      from hits h join folders f on f.id = h.id
      union all
      select up.hit, f.id, f.parent_id, f.name, up.depth + 1
      from folders f join up on f.id = up.parent_id
      where up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select h.id::text as id,
           h.name,
           h.parent_id::text as parent_id,
           h.created_by::text as created_by,
           h.created_at,
           h.updated_at,
           coalesce(
             (select json_agg(json_build_object('id', up.id::text, 'name', up.name) order by up.depth desc)
              from up where up.hit = h.id),
             '[]'::json
           ) as breadcrumbs
    from hits h
    order by lower(h.name), h.id
  `);
  return {
    folders: rows.slice(0, FOLDER_SEARCH_LIMIT).map((row) => ({
      ...toFolderSummary(row),
      breadcrumbs: row.breadcrumbs,
    })),
    truncated: rows.length > FOLDER_SEARCH_LIMIT,
  };
}

export async function createFolder(params: {
  parentId: EntityID | null;
  name: string;
  actor: Actor;
}): Promise<FolderSummary> {
  const { parentId, name, actor } = params;
  try {
    return await withTransaction(async (tx) => {
      await lockTree(tx);
      if (parentId === null) await assertRoomUnder(tx, null);
      else {
        const { depth } = await lockParent(tx, parentId);
        if (depth + 1 > FOLDER_MAX_DEPTH)
          throw new CustomError(
            mediaMsg.folderTooDeep,
            HTTP_STATUS.UNPROCESSABLE
          );
      }

      const [created] = await tx
        .insert(folders)
        .values({ parentId, name, createdBy: actor.userId })
        .returning(FOLDER_COLUMNS);
      if (!created)
        throw new CustomError(mediaMsg.updateError, HTTP_STATUS.INTERNAL_ERROR);

      await auditAs(tx, actor, {
        action: 'INSERT',
        tableName: 'folders',
        recordId: created.id,
        newData: { name, parentId },
      });
      return created;
    });
  } catch (error) {
    throw folderNameConflict(error) ?? error;
  }
}

export async function updateFolder(params: {
  folderId: EntityID;
  name?: string;
  /** `null` moves to the root; `undefined` leaves the parent alone. */
  parentId?: EntityID | null;
  actor: Actor;
}): Promise<FolderSummary> {
  const { folderId, name, parentId, actor } = params;
  try {
    return await withTransaction(async (tx) => {
      await lockTree(tx);
      const current = await lockFolderFor(tx, folderId, actor);

      const moving = parentId !== undefined && parentId !== current.parentId;
      if (moving && parentId === null) await assertRoomUnder(tx, null);
      if (moving && parentId !== null) {
        const { ids, height } = await subtreeOf(tx, folderId);
        if (ids.has(parentId))
          throw new CustomError(
            mediaMsg.folderCycle,
            HTTP_STATUS.UNPROCESSABLE
          );
        const { depth } = await lockParent(tx, parentId);
        if (depth + height > FOLDER_MAX_DEPTH)
          throw new CustomError(
            mediaMsg.folderTooDeep,
            HTTP_STATUS.UNPROCESSABLE
          );
      }

      const [updated] = await tx
        .update(folders)
        .set({
          ...(name !== undefined && { name }),
          ...(moving && { parentId }),
        })
        .where(eq(folders.id, folderId))
        .returning(FOLDER_COLUMNS);
      if (!updated)
        throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

      await auditAs(tx, actor, {
        action: 'UPDATE',
        tableName: 'folders',
        recordId: folderId,
        oldData: { name: current.name, parentId: current.parentId },
        newData: { name: updated.name, parentId: updated.parentId },
        skipIfUnchanged: true,
      });
      return updated;
    });
  } catch (error) {
    throw folderNameConflict(error) ?? error;
  }
}

/** Empty folders only; `deleteFolderTree` (`./lifecycle.ts`) is the recursive delete. */
export async function deleteFolder(params: {
  folderId: EntityID;
  actor: Actor;
}): Promise<FolderDeleteOutcome> {
  const { folderId, actor } = params;
  await withTransaction(async (tx) => {
    await lockTree(tx);
    const current = await lockFolderFor(tx, folderId, actor);

    const [children] = await tx
      .select({ count: rowCount() })
      .from(folders)
      .where(childrenOf(folderId));
    // Any row, whatever its status: a pending upload or a half-deleted file in
    // here is still an object the folder is responsible for.
    const [contents] = await tx
      .select({ count: rowCount() })
      .from(files)
      .where(eq(files.folderId, folderId));
    if ((children?.count ?? 0) > 0 || (contents?.count ?? 0) > 0)
      throw new CustomError(mediaMsg.folderNotEmpty, HTTP_STATUS.CONFLICT);

    await tx.delete(folders).where(eq(folders.id, folderId));

    await auditAs(tx, actor, {
      action: 'DELETE',
      tableName: 'folders',
      recordId: folderId,
      oldData: { name: current.name, parentId: current.parentId },
    });
  });
  return { folders: 1, deleted: [], pending: [] };
}
