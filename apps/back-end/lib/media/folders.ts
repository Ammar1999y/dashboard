import type { Actor } from './actor';
import type { Executor, Tx } from '@/db';
import type {
  mediaFolderDetailsSchema,
  mediaFolderHitSchema,
  mediaFolderSchema,
} from '@app/shared/responses/media';
import type { EntityID } from '@app/shared/types';

import { asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { getConstraintName, isUniqueViolation } from '@/db/errors';
import { folders } from '@/db/schema';
import * as z from 'zod';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
} from '@app/shared/validation/constants';

import { escapeLike } from '@/lib/data-table/filter-columns';
import { userNames } from '@/lib/users/names';

import { auditAs, withinScope } from './actor';
import {
  folderCycle,
  folderNameExists,
  folderNotFound,
  folderTooDeep,
  folderTooManyChildren,
} from './errors';
import { anyUuid, distinctIds, idRowSchema } from './ids';

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type MediaFolder = z.input<typeof mediaFolderSchema>;
type FolderHit = z.input<typeof mediaFolderHitSchema>;
type FolderDetails = z.input<typeof mediaFolderDetailsSchema>;

const FOLDER_COLUMNS = {
  id: folders.id,
  name: folders.name,
  parentId: folders.parentId,
  createdBy: folders.createdBy,
  createdAt: folders.createdAt,
  updatedAt: folders.updatedAt,
} as const;

/**
 * Direct contents only, active files only. `fileCount` reads heap rows: no
 * `folder_id` index carries `status`.
 *
 * ⚠️ The outer row is named `folders.id` in the text, not `${folders.id}`: in
 * a single-table select list Drizzle renders a column unqualified, which here
 * would name the subquery's own row.
 */
const FOLDER_FIGURES = {
  subfolderCount: sql<number>`(select count(*)::int from folders child where child.parent_id = folders.id)`,
  fileCount: sql<number>`(select count(*)::int from files held where held.folder_id = folders.id and held.status = 'active')`,
} as const;

/*
 * The rows of the raw statements below. The driver types them
 * `Record<string, any>` whatever `execute<T>` is given, so each is parsed
 * against the columns its SQL selects: ids as text, timestamps as the `Date`
 * the driver returns.
 */
const breadcrumbRowSchema = z.object({ id: z.string(), name: z.string() });

const folderHitRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  subfolder_count: z.number(),
  file_count: z.number(),
  breadcrumbs: z.array(breadcrumbRowSchema),
});

const totalsRowSchema = z.object({
  folders: z.number(),
  files: z.number(),
  bytes: z.number(),
});

/** Direct children of `parentId`; `null` is the root. */
const childrenOf = (parentId: EntityID | null) =>
  parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId);

const rowCount = () => sql<number>`count(*)::int`;

const FOLDER_UNIQUE_CONSTRAINTS = new Set([
  'ux_folders_parent_name',
  'ux_folders_root_name',
]);

/**
 * A duplicate name is the one constraint a client can correct; anything else
 * is a bug. `folderIds` names the folders written, where they exist yet.
 */
export function folderNameConflict(
  error: unknown,
  folderIds?: readonly EntityID[]
): CustomError | null {
  if (!isUniqueViolation(error)) return null;
  return FOLDER_UNIQUE_CONSTRAINTS.has(getConstraintName(error))
    ? folderNameExists(folderIds)
    : null;
}

/**
 * Row locks cannot stop two disjoint moves (`A` under `B1`, `B` under `A1`)
 * from both committing a cycle, so every structural change takes this lock
 * FIRST, before any row lock. One lock for the whole tree is deliberate:
 * folder mutations are rare. Exported for `./selection.ts`, which this module
 * must not import, or the two form an import cycle.
 */
export async function lockTree(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('media.folders'))`
  );
}

/**
 * Root → leaf, so its length is the folder's depth (1 for a root folder, 0
 * for none). Bounded by the depth cap plus one, so a cycle in the table ends
 * the query rather than the server.
 */
export async function breadcrumbs(
  folderId: EntityID,
  executor: Executor = db
): Promise<z.output<typeof breadcrumbRowSchema>[]> {
  const rows = await executor.execute(sql`
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
  return rows.map((row) => breadcrumbRowSchema.parse(row));
}

/** The fan-out cap on one parent; `null` is the root. Runs under `lockTree`. */
async function assertRoomUnder(
  tx: Tx,
  parentId: EntityID | null,
  incoming: number
): Promise<void> {
  const [count] = await tx
    .select({ children: rowCount() })
    .from(folders)
    .where(childrenOf(parentId));
  if ((count?.children ?? 0) + incoming > FOLDER_MAX_CHILDREN)
    throw folderTooManyChildren();
}

/**
 * `NO KEY UPDATE` throughout: `lockTree` already serialises every structural
 * writer, and the weaker lock lets an upload or a file move into the folder
 * (`KEY SHARE`, through the foreign key) proceed instead of queueing behind it.
 */
const STRUCTURE_LOCK = 'no key update';

/** The prospective parent's depth, with the fan-out cap checked under it. */
async function lockParent(
  tx: Tx,
  parentId: EntityID
): Promise<{ depth: number }> {
  const [parent] = await tx
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, parentId))
    .for(STRUCTURE_LOCK);
  if (!parent) throw folderNotFound();

  const trail = await breadcrumbs(parentId, tx);
  if (trail.length === 0) throw folderNotFound();

  await assertRoomUnder(tx, parentId, 1);
  return { depth: trail.length };
}

async function lockFolderFor(
  tx: Tx,
  folderId: EntityID,
  actor: Actor
): Promise<FolderSummary> {
  const [folder] = await tx
    .select(FOLDER_COLUMNS)
    .from(folders)
    .where(eq(folders.id, folderId))
    .for(STRUCTURE_LOCK);
  // Out of scope answers exactly like absent.
  if (!folder || !withinScope(actor, folder.createdBy)) throw folderNotFound();
  return folder;
}

export async function requireFolder(
  folderId: EntityID,
  executor: Executor = db
): Promise<void> {
  const [folder] = await executor
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, folderId));
  if (!folder) throw folderNotFound();
}

/** Folder rows as answered: one name query for any number of them. */
async function toWireFolders<
  T extends { createdBy: string | null; createdAt: Date; updatedAt: Date },
>(
  rows: readonly T[],
  executor: Executor = db
): Promise<
  Array<
    Omit<T, 'createdAt' | 'updatedAt'> & {
      createdAt: string;
      updatedAt: string;
      createdByName: string | null;
    }
  >
> {
  const nameOf = await userNames(
    rows.map((row) => row.createdBy),
    executor
  );
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdByName: nameOf(row.createdBy),
  }));
}

/** Direct children, by name. Bounded by the cap, which the root shares, so never paginated. */
export async function listSubfolders(
  parentId: EntityID | null
): Promise<MediaFolder[]> {
  const rows = await db
    .select({ ...FOLDER_COLUMNS, ...FOLDER_FIGURES })
    .from(folders)
    .where(childrenOf(parentId))
    .orderBy(asc(sql`lower(${folders.name})`), asc(folders.id))
    .limit(FOLDER_MAX_CHILDREN);
  return toWireFolders(rows);
}

/** Folder hits one library search names; more are reported as truncated. */
export const FOLDER_SEARCH_LIMIT = 20;

/**
 * One statement, so the hits do not cost a recursive query each. `term`
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
           (select count(*)::int from folders child where child.parent_id = h.id) as subfolder_count,
           (select count(*)::int from files held where held.folder_id = h.id and held.status = 'active') as file_count,
           coalesce(
             (select json_agg(json_build_object('id', up.id::text, 'name', up.name) order by up.depth desc)
              from up where up.hit = h.id),
             '[]'::json
           ) as breadcrumbs
    from hits h
    order by lower(h.name), h.id
  `);
  const hits = rows.slice(0, FOLDER_SEARCH_LIMIT).map((row) => {
    const hit = folderHitRowSchema.parse(row);
    return {
      id: hit.id,
      name: hit.name,
      parentId: hit.parent_id,
      createdBy: hit.created_by,
      subfolderCount: hit.subfolder_count,
      fileCount: hit.file_count,
      createdAt: hit.created_at,
      updatedAt: hit.updated_at,
      breadcrumbs: hit.breadcrumbs,
    };
  });
  return {
    folders: await toWireFolders(hits),
    truncated: rows.length > FOLDER_SEARCH_LIMIT,
  };
}

/**
 * The whole subtree in one aggregate statement: every folder below this one,
 * and the active files and bytes at any depth. Unbounded in rows read, which
 * is why only this route, not a listing, carries it.
 */
async function subtreeTotals(
  executor: Executor,
  folderId: EntityID
): Promise<z.output<typeof totalsRowSchema>> {
  const [row] = await executor.execute(sql`
    with recursive down as (
      select id, 1 as level from folders where id = ${folderId}::uuid
      union all
      select f.id, down.level + 1
      from folders f join down on f.parent_id = down.id
      where down.level <= ${FOLDER_MAX_DEPTH}
    ), held as (
      select x.size_bytes from files x join down on x.folder_id = down.id
      where x.status = 'active'
    )
    select (select count(*)::int - 1 from down) as folders,
           (select count(*)::int from held) as files,
           (select coalesce(sum(size_bytes), 0)::float8 from held) as bytes
  `);
  return totalsRowSchema.parse(row);
}

/**
 * One snapshot for every read: a delete or a move landing between them would
 * otherwise pair the row with another tree, or total a root that is gone.
 */
export async function folderDetails(
  folderId: EntityID
): Promise<FolderDetails> {
  return withTransaction(
    async (tx) => {
      const [row] = await tx
        .select({ ...FOLDER_COLUMNS, ...FOLDER_FIGURES })
        .from(folders)
        .where(eq(folders.id, folderId));
      if (!row) throw folderNotFound();
      const [named] = await toWireFolders([row], tx);
      if (!named) throw new Error('toWireFolders dropped its only row');
      return {
        ...named,
        breadcrumbs: await breadcrumbs(folderId, tx),
        totals: await subtreeTotals(tx, folderId),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
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
      if (parentId === null) await assertRoomUnder(tx, null, 1);
      else {
        const { depth } = await lockParent(tx, parentId);
        if (depth + 1 > FOLDER_MAX_DEPTH) throw folderTooDeep();
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

/** Each moved folder's subtree height above `allowed`, the ones that would not fit. */
async function tooTall(
  tx: Tx,
  folderIds: readonly EntityID[],
  allowed: number
): Promise<EntityID[]> {
  const rows = await tx.execute(sql`
    with recursive down as (
      select id as root, id, 1 as level
      from folders where id = ${anyUuid(folderIds)}
      union all
      select down.root, f.id, down.level + 1
      from folders f join down on f.parent_id = down.id
      where down.level <= ${allowed}
    )
    select root::text as id from down group by root having max(level) > ${allowed}
  `);
  return rows.map((row) => idRowSchema.parse(row).id);
}

/**
 * The folder half of every move, under `lockTree`: the moved folders and the
 * destination locked in `id` order, then the cycle, depth and fan-out rules.
 * Answers the selected folders and the ones whose parent actually changes.
 *
 * Names are not checked here: `assertNamesFree` does it for a selection, and a
 * single rename-and-move leaves it to the unique index, which sees the new name.
 */
export async function prepareFolderMove(
  tx: Tx,
  params: {
    folderIds: readonly EntityID[];
    to: EntityID | null;
    actor: Pick<Actor, 'userId' | 'scope'>;
  }
): Promise<{ selected: FolderSummary[]; moving: FolderSummary[] }> {
  const { to, actor } = params;
  const ids = distinctIds(params.folderIds);
  const locked = await tx
    .select(FOLDER_COLUMNS)
    .from(folders)
    .where(inArray(folders.id, to === null ? ids : [...new Set([...ids, to])]))
    .orderBy(asc(folders.id))
    .for(STRUCTURE_LOCK);
  const byId = new Map(locked.map((folder) => [folder.id, folder]));
  const selected = ids.map((id) => byId.get(id));
  if (to !== null && !byId.has(to)) throw folderNotFound();
  const visible = selected.filter(
    (folder): folder is FolderSummary =>
      folder !== undefined && withinScope(actor, folder.createdBy)
  );
  if (visible.length !== ids.length) throw folderNotFound();

  const moving = visible.filter((folder) => folder.parentId !== to);
  if (moving.length === 0) return { selected: visible, moving };

  // Under the root nothing can be too deep: every subtree already fits below it.
  if (to !== null) {
    const trail = await breadcrumbs(to, tx);
    const selectedIds = new Set(ids);
    const cyclic = trail.filter((step) => selectedIds.has(step.id));
    if (cyclic.length > 0) throw folderCycle(cyclic.map((step) => step.id));
    const deep = await tooTall(
      tx,
      moving.map((folder) => folder.id),
      FOLDER_MAX_DEPTH - trail.length
    );
    if (deep.length > 0) throw folderTooDeep(deep);
  }

  await assertRoomUnder(tx, to, moving.length);
  return { selected: visible, moving };
}

/**
 * Each moved folder against the destination's other children and against the
 * rest of the selection, compared as the unique indexes compare. The indexes
 * stay the backstop; this is what can name the folders.
 */
export async function assertNamesFree(
  tx: Tx,
  folderIds: readonly EntityID[],
  to: EntityID | null
): Promise<void> {
  if (folderIds.length === 0) return;
  const moved = anyUuid(folderIds);
  const rows = await tx.execute(sql`
    with incoming as (
      select id, lower(name) as key from folders where id = ${moved}
    ), staying as (
      select lower(name) as key from folders
      where ${to === null ? sql`parent_id is null` : sql`parent_id = ${to}::uuid`}
        and not (id = ${moved})
    )
    select i.id::text as id from incoming i
    where exists (select 1 from staying s where s.key = i.key)
       or exists (select 1 from incoming j where j.key = i.key and j.id <> i.id)
  `);
  const clashing = rows.map((row) => idRowSchema.parse(row).id);
  if (clashing.length > 0) throw folderNameExists(clashing);
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
      let current: FolderSummary | undefined;
      let moving = false;
      if (parentId === undefined)
        current = await lockFolderFor(tx, folderId, actor);
      else {
        const move = await prepareFolderMove(tx, {
          folderIds: [folderId],
          to: parentId,
          actor,
        });
        current = move.selected[0];
        moving = move.moving.length > 0;
      }
      if (!current) throw folderNotFound();

      const [updated] = await tx
        .update(folders)
        .set({
          ...(name !== undefined && { name }),
          ...(moving && { parentId }),
        })
        .where(eq(folders.id, folderId))
        .returning(FOLDER_COLUMNS);
      if (!updated) throw folderNotFound();

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
    throw folderNameConflict(error, [folderId]) ?? error;
  }
}
