import {
  deleteMediaFiles,
  getMediaFile,
  moveMediaFiles,
  publishMediaFile,
  unpublishMediaFile,
  updateMediaFile,
  uploadMediaFile,
} from '@app/shared/api/media';
import { mediaMsg } from '@app/shared/messages/media';
import { MEDIA_USAGE_LIST_MAX } from '@app/shared/validation/constants';

import { bind, refusalOf } from '@/lib/http/binding';
import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { grantedActor, requestActor } from '@/lib/media/actor';
import { fileNotFound } from '@/lib/media/errors';
import {
  downloadUrl,
  findFile,
  previewUrl,
  toMediaFile,
  updateFile,
} from '@/lib/media/files';
import { requireFolder } from '@/lib/media/folders';
import { DEFAULT_UPLOAD_PURPOSE } from '@/lib/media/policy';
import {
  DELETE_LIMIT,
  deleteFiles,
  MOVE_LIMIT,
  moveSelection,
} from '@/lib/media/selection';
import { signingWindow } from '@/lib/media/signing';
import { acceptUpload } from '@/lib/media/upload';
import { fileUsages, viewablePages } from '@/lib/media/usages';
import { transitionFile } from '@/lib/media/visibility';

import { MEDIA_ROUTE_TIMEOUT_SECONDS, UPLOAD_ADMISSION } from './limits';

/**
 * Nothing done at upload time makes a file public: with no private bucket this
 * answers 422 rather than publish what `media.create` alone may not.
 */
const LIBRARY_UPLOAD_VISIBILITY = 'private';

/** A malformed id reads like an id that matched nothing. */
const FILE_ID_REFUSALS = { params: refusalOf(fileNotFound()) };

const PUBLISH_LIMIT = 60;
/**
 * Far below publish's: each unpublish spends cache purges from the
 * deployment-wide budget in `lib/cloudflare/purge.ts`, which a few users at
 * publish's rate would exhaust.
 */
const UNPUBLISH_LIMIT = 10;

export const uploadMediaFileBinding = bind(uploadMediaFile, {
  permission: { resource: 'media', action: 'create' },
  rateLimit: UPLOAD_ADMISSION,
  failure: mediaMsg.uploadFailed,
  // The folder is checked before the body is processed and the row inserted
  // after; a delete in between fails the insert's foreign key.
  mapError: handleFolderForeignKeyViolation,
  // Image processing, then the upload itself.
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: { summary: 'Upload a file into a media folder', tags: ['Media'] },
  handler: async ({ query, actor, meta }) => {
    await requireFolder(query.folder);

    const row = await acceptUpload(
      meta,
      requestActor(meta, actor),
      {
        field: 'file',
        visibility: LIBRARY_UPLOAD_VISIBILITY,
        kinds: DEFAULT_UPLOAD_PURPOSE.kinds,
        folderId: query.folder,
        activate: true,
      },
      meta.chargeRateLimit
    );

    return { message: mediaMsg.uploaded, data: await toMediaFile(row) };
  },
});

export const moveMediaFilesBinding = bind(moveMediaFiles, {
  permission: { resource: 'media', action: 'edit' },
  rateLimit: { ...MOVE_LIMIT, failClosed: true, by: 'user' },
  failure: mediaMsg.updateError,
  mapError: handleFolderForeignKeyViolation,
  detail: {
    summary: 'Move media files into a folder',
    deprecated: true,
    description:
      'Superseded by `PUT /api/dash/media`, which runs the same move; removed in a later release. One transaction for the whole selection: every id has to be an active library file the caller may edit, or nothing moves and the answer is 404. Moving an unfiled file (`scope=unfiled`) into a folder adopts it into the library and takes it off the retention clock, exactly as the single-file route does.',
    tags: ['Media'],
  },
  handler: async ({ body, actor, meta }) => {
    const { updatedAt } = await moveSelection({
      fileIds: body.ids,
      folderIds: [],
      to: body.folderId,
      actor: grantedActor(meta, actor),
    });
    return { message: mediaMsg.updated, data: { unfiledAt: null, updatedAt } };
  },
});

export const deleteMediaFilesBinding = bind(deleteMediaFiles, {
  permission: { resource: 'media', action: 'delete' },
  rateLimit: { ...DELETE_LIMIT, failClosed: true, by: 'user' },
  failure: mediaMsg.deleteError,
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: {
    summary: 'Delete media files',
    deprecated: true,
    description:
      'Superseded by `DELETE /api/dash/media`, which runs the same delete; removed in a later release. Refused as a whole (409) while any record references one of the files. Otherwise every file is committed to deletion and disappears from every listing at once; `deleted` names the ones whose object is already gone, `pending` the ones the object store or a configured cache purge refused, which the nightly sweep finishes. An unfiled file (`scope=unfiled`) is deleted by the sweep on its own after `retentionDays`.',
    tags: ['Media'],
  },
  handler: async ({ body, actor, meta }) => {
    const { deleted, pending } = await deleteFiles({
      ids: body.ids,
      actor: grantedActor(meta, actor),
      viewable: viewablePages(actor.permissions),
    });
    return { message: mediaMsg.deleted, data: { deleted, pending } };
  },
});

export const getMediaFileBinding = bind(getMediaFile, {
  permission: { resource: 'media', action: 'view' },
  rateLimit: { scope: 'media.files.id.get', limit: 120, by: 'user' },
  failure: mediaMsg.fetchError,
  refusals: FILE_ID_REFUSALS,
  detail: {
    summary: 'Get a media file, its download URL and where it is used',
    description: `\`usedBy\` names at most ${MEDIA_USAGE_LIST_MAX} owners the caller may view; \`visibleUsages\` counts all of them and \`hiddenUsages\` the ones on pages the caller may not view. \`previewUrl\` is set for a PDF only.`,
    tags: ['Media'],
  },
  handler: async ({ params, actor }) => {
    const { id } = params;
    const row = await findFile(id);
    // A pending or deleting row is not a file the library has; one a record
    // still holds is that record's, not the library's.
    if (!row || row.status !== 'active' || !row.governed) throw fileNotFound();

    const usages = await fileUsages(id, viewablePages(actor.permissions));
    const inUse = usages.visibleCount + usages.hidden > 0;
    const window = signingWindow(Date.now());
    const [file, download, preview] = await Promise.all([
      toMediaFile(row, { usedIds: new Set(inUse ? [id] : []) }),
      downloadUrl(row, window),
      previewUrl(row, window),
    ]);

    return {
      message: mediaMsg.fetched,
      data: {
        ...file,
        downloadUrl: download,
        previewUrl: preview,
        usedBy: usages.visible,
        visibleUsages: usages.visibleCount,
        hiddenUsages: usages.hidden,
      },
    };
  },
});

export const updateMediaFileBinding = bind(updateMediaFile, {
  permission: { resource: 'media', action: 'edit' },
  rateLimit: {
    scope: 'media.files.id.put',
    limit: 30,
    failClosed: true,
    by: 'user',
  },
  failure: mediaMsg.updateError,
  mapError: handleFolderForeignKeyViolation,
  refusals: FILE_ID_REFUSALS,
  detail: { summary: 'Rename or move a media file', tags: ['Media'] },
  handler: async ({ params, body, actor, meta }) => {
    const updated = await updateFile({
      id: params.id,
      displayName: body.displayName,
      folderId: body.folderId,
      actor: grantedActor(meta, actor),
    });

    return {
      message: mediaMsg.updated,
      data: {
        ...(body.displayName !== undefined && {
          displayName: updated.displayName,
        }),
        // `updateFile` files the row, which clears the stamp.
        ...(body.folderId !== undefined && { unfiledAt: null }),
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  },
});

/**
 * Private → public. `publish` has no `Own` variant, so `resolveActionScope`
 * answers `scope: 'all'` and the uploader narrowing never applies: publishing
 * is an editorial decision about the file, not about who uploaded it.
 */
export const publishMediaFileBinding = bind(publishMediaFile, {
  // Not the cookie cache: this changes who on the internet can read the
  // object, so the grant behind it has to be the current one.
  permission: { resource: 'media', action: 'publish', forceDB: true },
  // Two R2 calls and a HeadObject per file.
  rateLimit: {
    scope: 'media.files.publish',
    limit: PUBLISH_LIMIT,
    failClosed: true,
    by: 'user',
  },
  failure: mediaMsg.updateError,
  refusals: FILE_ID_REFUSALS,
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: {
    summary: 'Move a media file to the public bucket',
    description: `Copies the object to the public bucket under the same key, verifies the copy, then flips the row; \`url\` becomes the permanent public URL. Idempotent for a file that is already public. The returned \`transition\` is \`cleanup\` while the stale private copy is still being removed. Limited to ${PUBLISH_LIMIT} per minute per user, apart from unpublish.`,
    tags: ['Media'],
  },
  handler: async ({ params, actor, meta }) => {
    const row = await transitionFile({
      id: params.id,
      to: 'public',
      actor: requestActor(meta, actor, 'all'),
    });
    return { message: mediaMsg.published, data: await toMediaFile(row) };
  },
});

/**
 * Public → private, the mirror of `publish` under the same grant; the saga
 * refuses while a public owner still references the file.
 */
export const unpublishMediaFileBinding = bind(unpublishMediaFile, {
  permission: { resource: 'media', action: 'publish', forceDB: true },
  rateLimit: {
    scope: 'media.files.unpublish',
    limit: UNPUBLISH_LIMIT,
    failClosed: true,
    by: 'user',
  },
  failure: mediaMsg.updateError,
  refusals: FILE_ID_REFUSALS,
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: {
    summary: 'Move a media file back to the private bucket',
    description: `Refused (409) while a published record still references the file. Otherwise the object is copied to the private bucket, the row flips and \`url\` becomes a signed URL; the returned \`transition\` is \`cleanup\` until the cleanup below has finished. Three outcomes, and they are not the same: the object is ALWAYS removed from the public origin; an edge copy is evicted only when the cache purge is configured, and the nightly sweep retries that until it succeeds; a copy already in a BROWSER stays readable until its \`Cache-Control\` lifetime ends (up to a year for a public image) and no purge, configured or not, can reach it. Unpublishing is therefore not an access revocation for anyone who has already fetched the object. Limited to ${UNPUBLISH_LIMIT} per minute per user: each one spends cache purges from a budget the whole deployment shares.`,
    tags: ['Media'],
  },
  handler: async ({ params, actor, meta }) => {
    const row = await transitionFile({
      id: params.id,
      to: 'private',
      actor: requestActor(meta, actor, 'all'),
    });
    return { message: mediaMsg.unpublished, data: await toMediaFile(row) };
  },
});
