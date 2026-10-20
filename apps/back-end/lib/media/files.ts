import type { Actor } from './actor';
import type { SigningWindow } from './signing';
import type { Executor, Tx } from '@/db';
import type { File as FileRow } from '@/db/schema';
import type { ObjectHead } from '@/lib/r2/client';
import type { mediaFileSchema } from '@app/shared/responses/media';
import type { EntityID } from '@app/shared/types';
import type { KnownMimeType } from '@app/shared/validation/media-types';
import type { SQL } from 'drizzle-orm';
import type * as z from 'zod';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files, folders } from '@/db/schema';

import { normalizeMimeType } from '@app/shared/validation/media-types';

import {
  checksumSha256Of,
  getPresignedUrl,
  getPublicUrl,
  hasPublicUrl,
} from '@/lib/r2/client';
import { userNames } from '@/lib/users/names';

import { auditAs, withinScope } from './actor';
import { FILE_TYPE_TABLE } from './allowlist';
import { fileBusy, fileNotFound } from './errors';
import { requireFolder } from './folders';
import { getContentDisposition } from './headers';
import { distinctIds } from './ids';
import {
  PRIVATE_IMAGE_CACHE_CONTROL,
  signingWindow,
  UNCACHED,
} from './signing';
import { unreferenced, usedIds } from './usages';

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

/**
 * Past this a `pending` row or a transition marker is abandoned: its request
 * cannot still be running. R2's worst case per write, 3 × (3 s connect + 15 s
 * request) in `lib/r2/client.ts`, must stay well inside it; too long keeps an
 * abandoned file unpublishable and its folder undeletable.
 */
export const ABANDONED_UPLOAD_MINUTES = 10;
export const ABANDONED_AFTER = `${ABANDONED_UPLOAD_MINUTES} minutes`;

/**
 * A library file or one no registered owner holds; a record-held upload is
 * reached only through its record's routes, whatever media grant the caller has.
 *
 * ⚠️ Never inside the statement that takes the row lock: under Read Committed
 * its sub-plan keeps the original snapshot, so a claim committing during the
 * lock wait is invisible. Lock first, then call `governedIds`.
 */
export function mediaGoverned(): SQL<boolean> {
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
export async function lockFilesForEdit(
  tx: Tx,
  ids: readonly EntityID[],
  actor: Pick<Actor, 'userId' | 'scope'>
): Promise<MediaFileRow[]> {
  const wanted = distinctIds(ids);
  const rows = await tx
    .select(FILE_COLUMNS)
    .from(files)
    .where(inArray(files.id, wanted))
    .orderBy(asc(files.id))
    .for('update');
  const governed = await governedIds(tx, wanted);
  const editable = rows.filter(
    (row) =>
      row.status === 'active' &&
      governed.has(row.id) &&
      withinScope(actor, row.uploadedBy)
  );
  if (editable.length !== wanted.length) throw fileNotFound();
  // 409 after the disclosure gate, since the caller can see this file. A
  // transition copies the object with the row's current name in
  // `Content-Disposition`, so a rename mid-transition would serve the old name.
  const busy = editable.filter((row) => row.transition);
  if (busy.length > 0) throw fileBusy(busy.map((row) => row.id));
  return editable;
}

/** Filing is also how an unfiled file leaves the retention clock. */
export const filedInto = (folderId: EntityID) =>
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
    if (!current) throw fileNotFound();
    if (folderId !== undefined) await requireFolder(folderId, tx);

    const [row] = await tx
      .update(files)
      .set({
        ...(displayName !== undefined && { displayName }),
        ...(folderId !== undefined && filedInto(folderId)),
      })
      .where(eq(files.id, id))
      .returning(FILE_COLUMNS);
    if (!row) throw fileNotFound();

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

/**
 * What the library holds: every folder, and the active files it governs, with
 * their bytes. One aggregate statement.
 */
export async function libraryTotals(): Promise<{
  folders: number;
  files: number;
  bytes: number;
}> {
  const [row] = await db
    .select({
      folders: sql<number>`(select count(*)::int from ${folders})`,
      files: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8`,
    })
    .from(files)
    .where(and(eq(files.status, 'active'), mediaGoverned()));
  return row ?? { folders: 0, files: 0, bytes: 0 };
}

/** What every route that returns a file sends. */
export type MediaFile = z.input<typeof mediaFileSchema>;

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
function fileUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType' | 'kind'>,
  window: SigningWindow
): Promise<string> | string {
  if (row.bucketType === 'public' && hasPublicUrl())
    return getPublicUrl(row.r2Key);
  return getPresignedUrl({
    key: row.r2Key,
    bucketType: row.bucketType,
    ...window,
    ...(row.kind === 'image' &&
      row.bucketType === 'private' && {
        responseCacheControl: PRIVATE_IMAGE_CACHE_CONTROL,
      }),
  });
}

/**
 * The only way a rename reaches "save as": the disposition baked into the
 * object cannot follow it, and a link's `download` attribute is ignored
 * cross-origin.
 */
export function downloadUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType' | 'displayName' | 'mimeType'>,
  window: SigningWindow = signingWindow(Date.now())
): Promise<string> {
  return getPresignedUrl({
    key: row.r2Key,
    bucketType: row.bucketType,
    ...window,
    responseContentDisposition: getContentDisposition({
      filename: downloadFilename(row),
    }),
    responseCacheControl: UNCACHED,
  });
}

/**
 * The one inline rendering of a document, and only of a PDF. Always signed on
 * the S3 endpoint, never the public domain: that origin is a separate site
 * with no cookies, which is what makes the PDF viewer's scripting harmless.
 */
const PREVIEWED: KnownMimeType = 'application/pdf';

export function previewUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType' | 'displayName' | 'mimeType'>,
  window: SigningWindow = signingWindow(Date.now())
): Promise<string> | null {
  if (normalizeMimeType(row.mimeType) !== PREVIEWED) return null;
  return getPresignedUrl({
    key: row.r2Key,
    bucketType: row.bucketType,
    ...window,
    responseContentDisposition: getContentDisposition({
      filename: downloadFilename(row),
      inline: true,
    }),
    responseContentType: PREVIEWED,
    responseCacheControl: UNCACHED,
  });
}

/** The parts of a file answer that are not on its row. */
interface FileExtras {
  inUse: boolean;
  uploadedByName: string | null;
  url: string;
}

function formatFile(row: MediaFileRow, extras: FileExtras): MediaFile {
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
    uploadedByName: extras.uploadedByName,
    unfiledAt: row.unfiledAt?.toISOString() ?? null,
    inUse: extras.inUse,
    url: extras.url,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The one way a file becomes an answer: a batch costs one usage query and one
 * name query whatever its size, and every link in it shares a window.
 * `known.usedIds` lets a caller that already read the usages skip that query.
 */
export async function toMediaFiles(
  rows: readonly MediaFileRow[],
  known: { usedIds?: ReadonlySet<EntityID> } = {}
): Promise<MediaFile[]> {
  if (rows.length === 0) return [];
  const names = userNames(rows.map((row) => row.uploadedBy));
  const [used] = await Promise.all([
    known.usedIds ?? usedIds(rows.map((row) => row.id)),
    names,
  ]);
  // A plain binding, not destructuring: the route-gates analyzer follows it.
  const nameOf = await names;
  const window = signingWindow(Date.now());
  return Promise.all(
    rows.map(async (row) =>
      formatFile(row, {
        inUse: used.has(row.id),
        uploadedByName: nameOf(row.uploadedBy),
        url: await fileUrl(row, window),
      })
    )
  );
}

export async function toMediaFile(
  row: MediaFileRow,
  known: { usedIds?: ReadonlySet<EntityID> } = {}
): Promise<MediaFile> {
  const [file] = await toMediaFiles([row], known);
  if (!file) throw new Error('toMediaFiles dropped its only row');
  return file;
}
