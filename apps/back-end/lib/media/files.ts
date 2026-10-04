import type { Actor } from './actor';
import type { Executor, Tx } from '@/db';
import type { File as FileRow } from '@/db/schema';
import type { ObjectHead } from '@/lib/r2/client';
import type { EntityID } from '@app/shared/types';
import type { SQL } from 'drizzle-orm';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { normalizeMimeType } from '@app/shared/validation/media-types';

import {
  checksumSha256Of,
  getPresignedUrl,
  getPublicUrl,
  hasPublicUrl,
} from '@/lib/r2/client';

import { auditAs, withinScope } from './actor';
import { FILE_TYPE_TABLE } from './allowlist';
import { requireFolder } from './folders';
import { getContentDisposition } from './headers';
import { unreferenced } from './usages';

/** The select shape every media read uses, so no two routes disagree on it. */
export const FILE_COLUMNS = {
  id: files.id,
  r2Key: files.r2Key,
  bucketType: files.bucketType,
  status: files.status,
  kind: files.kind,
  transition: files.transition,
  folderId: files.folderId,
  displayName: files.displayName,
  mimeType: files.mimeType,
  sizeBytes: files.sizeBytes,
  sha256: files.sha256,
  width: files.width,
  height: files.height,
  blurhash: files.blurhash,
  uploadedBy: files.uploadedBy,
  unfiledAt: files.unfiledAt,
  createdAt: files.createdAt,
  updatedAt: files.updatedAt,
} as const;

export type MediaFileRow = Pick<FileRow, keyof typeof FILE_COLUMNS>;

export function distinctIds(ids: readonly EntityID[]): EntityID[] {
  return [...new Set(ids)];
}

/**
 * A library file or one no registered owner holds; a record-held upload is
 * reached only through its record's routes, whatever media grant the caller has.
 *
 * ⚠️ Never inside the statement that takes the row lock: under Read Committed
 * its sub-plan keeps the original snapshot, so a claim committing during the
 * lock wait is invisible. Lock first, then call `governedIds`.
 */
function mediaGoverned(): SQL<boolean> {
  return sql<boolean>`(${files.folderId} is not null or (${unreferenced()}))`;
}

/**
 * Call AFTER the rows are locked `FOR UPDATE`: a referrer insert takes
 * `FOR KEY SHARE` through the composite FK, so no owner link can commit
 * between this and the write.
 */
export async function governedIds(
  tx: Tx,
  ids: readonly EntityID[]
): Promise<Set<EntityID>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.id, ids), mediaGoverned()));
  return new Set(rows.map((row) => row.id));
}

/** One row plus whether the media API may act on it (`mediaGoverned`), or `null`. */
export async function findFile(
  id: EntityID,
  executor: Executor = db
): Promise<(MediaFileRow & { governed: boolean }) | null> {
  const [row] = await executor
    .select({ ...FILE_COLUMNS, governed: mediaGoverned() })
    .from(files)
    .where(eq(files.id, id));
  return row ?? null;
}

/**
 * A missing, foreign or record-held id refuses the whole batch exactly like an
 * absent one, so the caller learns nothing about what it may not see.
 */
async function lockFilesForEdit(
  tx: Tx,
  ids: readonly EntityID[],
  actor: Pick<Actor, 'userId' | 'scope'>
): Promise<MediaFileRow[]> {
  const wanted = distinctIds(ids);
  const rows = await tx
    .select(FILE_COLUMNS)
    .from(files)
    .where(inArray(files.id, wanted))
    .for('update');
  const governed = await governedIds(tx, wanted);
  const editable = rows.filter(
    (row) =>
      row.status === 'active' &&
      governed.has(row.id) &&
      withinScope(actor, row.uploadedBy)
  );
  if (editable.length !== wanted.length)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
  // 409 after the disclosure gate, since the caller can see this file. A
  // transition copies the object with the row's current name in
  // `Content-Disposition`, so a rename mid-transition would serve the old name.
  if (editable.some((row) => row.transition))
    throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
  return editable;
}

/** Filing is also how an unfiled file leaves the retention clock. */
const filedInto = (folderId: EntityID) =>
  ({ folderId, unfiledAt: null }) as const;

/**
 * `folderId` is never null by design: adoption into the library is one-way,
 * and the way out is `DELETE`.
 */
export async function updateFile(params: {
  id: EntityID;
  displayName?: string;
  folderId?: EntityID;
  actor: Actor;
}): Promise<MediaFileRow> {
  const { id, displayName, folderId, actor } = params;
  return withTransaction(async (tx) => {
    const [current] = await lockFilesForEdit(tx, [id], actor);
    if (!current)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
    if (folderId !== undefined) await requireFolder(folderId, tx);

    const [row] = await tx
      .update(files)
      .set({
        ...(displayName !== undefined && { displayName }),
        ...(folderId !== undefined && filedInto(folderId)),
      })
      .where(eq(files.id, id))
      .returning(FILE_COLUMNS);
    if (!row)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    await auditAs(tx, actor, {
      action: 'UPDATE',
      tableName: 'files',
      recordId: id,
      oldData: {
        displayName: current.displayName,
        folderId: current.folderId,
      },
      newData: { displayName: row.displayName, folderId: row.folderId },
      skipIfUnchanged: true,
    });
    return row;
  });
}

/**
 * One transaction: a partly moved selection is a state nobody asked for, and a
 * request per file does not fit the route's rate limit.
 */
export async function moveFiles(params: {
  ids: readonly EntityID[];
  folderId: EntityID;
  actor: Actor;
}): Promise<Date> {
  const { actor, folderId } = params;
  const ids = distinctIds(params.ids);
  return withTransaction(async (tx) => {
    const current = await lockFilesForEdit(tx, ids, actor);
    await requireFolder(folderId, tx);

    // One statement, so every moved row carries the same `now()`.
    const [moved] = await tx
      .update(files)
      .set(filedInto(folderId))
      .where(inArray(files.id, ids))
      .returning({ updatedAt: files.updatedAt });
    if (!moved)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    for (const row of current)
      await auditAs(tx, actor, {
        action: 'UPDATE',
        tableName: 'files',
        recordId: row.id,
        oldData: { folderId: row.folderId },
        newData: { folderId },
        skipIfUnchanged: true,
      });
    return moved.updatedAt;
  });
}

/**
 * R2 returns the SHA-256 only for the object written with the checksum, never
 * for a copy of it, so a missing one is not a mismatch.
 */
export function matchesRow(
  head: ObjectHead,
  row: Pick<MediaFileRow, 'sizeBytes' | 'sha256'>
): boolean {
  if (head.contentLength !== row.sizeBytes) return false;
  if (!head.checksumSha256 || !row.sha256) return true;
  return head.checksumSha256 === checksumSha256Of(row.sha256);
}

/** The wire shape, shared by every route that returns a file. */
export interface MediaFile {
  id: string;
  kind: FileRow['kind'];
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  bucketType: FileRow['bucketType'];
  transition: FileRow['transition'];
  width: number | null;
  height: number | null;
  blurhash: string | null;
  folderId: string | null;
  uploadedBy: string | null;
  unfiledAt: Date | null;
  url: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The type table, not the allowlist: a type disabled after files of it were
 * stored keeps its extension.
 */
export function downloadFilename(
  row: Pick<MediaFileRow, 'displayName' | 'mimeType'>
): string {
  const extension = FILE_TYPE_TABLE.get(
    normalizeMimeType(row.mimeType)
  )?.extension;
  if (!extension) return row.displayName;
  return row.displayName.toLowerCase().endsWith(`.${extension}`)
    ? row.displayName
    : `${row.displayName}.${extension}`;
}

/**
 * `bucket_type` alone decides: during a `to_public` transition it says
 * `private` until the copy is verified.
 */
async function fileUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType'>
): Promise<string> {
  if (row.bucketType === 'public' && hasPublicUrl())
    return getPublicUrl(row.r2Key);
  return getPresignedUrl({ key: row.r2Key, bucketType: row.bucketType });
}

/**
 * The only way a rename reaches "save as": the disposition baked into the
 * object cannot follow it, and a link's `download` attribute is ignored
 * cross-origin.
 */
export function downloadUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType' | 'displayName' | 'mimeType'>
): Promise<string> {
  return getPresignedUrl({
    key: row.r2Key,
    bucketType: row.bucketType,
    responseContentDisposition: getContentDisposition({
      filename: downloadFilename(row),
    }),
  });
}

export async function toMediaFile(row: MediaFileRow): Promise<MediaFile> {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    bucketType: row.bucketType,
    transition: row.transition,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    folderId: row.folderId,
    uploadedBy: row.uploadedBy,
    unfiledAt: row.unfiledAt,
    url: await fileUrl(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMediaFiles(
  rows: readonly MediaFileRow[]
): Promise<MediaFile[]> {
  return Promise.all(rows.map((row) => toMediaFile(row)));
}
