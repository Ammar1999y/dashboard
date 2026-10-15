import {
  createMediaFolder,
  deleteMediaFolder,
  getMediaFolder,
  updateMediaFolder,
} from '@app/shared/api/media';
import { mediaMsg } from '@app/shared/messages/media';
import { FOLDER_RECURSIVE_DELETE_MAX } from '@app/shared/validation/constants';

import { bind, refusalOf } from '@/lib/http/binding';
import { grantedActor, requestActor } from '@/lib/media/actor';
import { folderNotFound } from '@/lib/media/errors';
import { ABANDONED_UPLOAD_MINUTES } from '@/lib/media/files';
import { createFolder, folderDetails, updateFolder } from '@/lib/media/folders';
import { DELETE_LIMIT, deleteSelection } from '@/lib/media/selection';
import { viewablePages } from '@/lib/media/usages';

import { MEDIA_ROUTE_TIMEOUT_SECONDS } from './limits';

/** A malformed id reads like an id that matched nothing. */
const FOLDER_ID_REFUSALS = { params: refusalOf(folderNotFound()) };

export const createMediaFolderBinding = bind(createMediaFolder, {
  permission: { resource: 'media', action: 'create' },
  rateLimit: {
    scope: 'media.folders.post',
    limit: 30,
    failClosed: true,
    by: 'user',
  },
  failure: mediaMsg.updateError,
  detail: { summary: 'Create a media folder', tags: ['Media'] },
  handler: async ({ body, actor, meta }) => {
    const folder = await createFolder({
      parentId: body.parentId ?? null,
      name: body.name,
      actor: requestActor(meta, actor, 'all'),
    });
    return {
      message: mediaMsg.folderCreated,
      data: { id: folder.id, name: folder.name },
    };
  },
});

export const getMediaFolderBinding = bind(getMediaFolder, {
  permission: { resource: 'media', action: 'view' },
  rateLimit: { scope: 'media.folders.id.get', limit: 120, by: 'user' },
  failure: mediaMsg.fetchError,
  refusals: FOLDER_ID_REFUSALS,
  detail: {
    summary: 'Get a media folder with its subtree totals',
    description:
      '`totals` covers the whole subtree: every folder below this one, and the active files and their bytes at any depth. `subfolderCount` and `fileCount` count direct contents only.',
    tags: ['Media'],
  },
  handler: async ({ params }) => ({
    message: mediaMsg.fetched,
    data: await folderDetails(params.id),
  }),
});

export const updateMediaFolderBinding = bind(updateMediaFolder, {
  permission: { resource: 'media', action: 'edit' },
  rateLimit: {
    scope: 'media.folders.id.put',
    limit: 30,
    failClosed: true,
    by: 'user',
  },
  failure: mediaMsg.updateError,
  refusals: FOLDER_ID_REFUSALS,
  detail: { summary: 'Rename or move a media folder', tags: ['Media'] },
  handler: async ({ params, body, actor, meta }) => {
    const folder = await updateFolder({
      folderId: params.id,
      name: body.name,
      parentId: body.parentId,
      actor: grantedActor(meta, actor),
    });
    return {
      message: mediaMsg.updated,
      data: {
        ...(body.name !== undefined && { name: folder.name }),
        updatedAt: folder.updatedAt.toISOString(),
      },
    };
  },
});

export const deleteMediaFolderBinding = bind(deleteMediaFolder, {
  permission: { resource: 'media', action: 'delete' },
  rateLimit: { ...DELETE_LIMIT, failClosed: true, by: 'user' },
  failure: mediaMsg.deleteError,
  refusals: FOLDER_ID_REFUSALS,
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: {
    summary: 'Delete a media folder, empty or whole',
    description: `The delete of \`DELETE /api/dash/media\` for one folder, \`recursive\` read from the query. Without it, a folder holding anything but uploads abandoned for ${ABANDONED_UPLOAD_MINUTES} minutes is a 409 \`FOLDER_NOT_EMPTY\`; abandoned uploads are deleted with it. With \`recursive=true\`, the folder and its whole subtree, at most ${FOLDER_RECURSIVE_DELETE_MAX} items besides the folder itself (422 \`SELECTION_TOO_LARGE\` above it). One transaction decides it all: a file a record references, a file changing visibility, or an upload younger than ${ABANDONED_UPLOAD_MINUTES} minutes refuses the whole delete before anything is removed. An \`own\`-scoped grant (\`deleteOwn\`) reaches the files as well as the folders: a subfolder someone else created, or an active file someone else uploaded, answers 404 and deletes nothing; an upload in progress or abandoned counts as above whoever started it.`,
    tags: ['Media'],
  },
  handler: async ({ params, query, actor, meta }) => ({
    message: mediaMsg.deleted,
    data: await deleteSelection({
      fileIds: [],
      folderIds: [params.id],
      recursive: query.recursive === 'true',
      actor: grantedActor(meta, actor),
      viewable: viewablePages(actor.permissions),
    }),
  }),
});
