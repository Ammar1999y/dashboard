import { and, count, eq, isNotNull } from 'drizzle-orm';

import { dataTableDb } from '@/db';
import { files } from '@/db/schema';

import {
  deleteMedia,
  getMediaStats,
  listMedia,
  moveMedia,
  previewMediaDelete,
} from '@app/shared/api/media';
import { MEDIA_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_FILTER } from '@app/shared/messages/data-table';
import { mediaMsg } from '@app/shared/messages/media';
import { FOLDER_RECURSIVE_DELETE_MAX } from '@app/shared/validation/constants';

import { parseDataTableParams } from '@/lib/data-table/params';
import { dataTableParameters } from '@/lib/data-table/query-parameters';
import { bind } from '@/lib/http/binding';
import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { grantedActor } from '@/lib/media/actor';
import {
  ABANDONED_UPLOAD_MINUTES,
  FILE_COLUMNS,
  libraryTotals,
  toMediaFiles,
} from '@/lib/media/files';
import {
  breadcrumbs,
  listSubfolders,
  requireFolder,
  searchFolders,
} from '@/lib/media/folders';
import { UNFILED_RETENTION_DAYS, unfiledNow } from '@/lib/media/lifecycle';
import {
  DELETE_LIMIT,
  deleteSelection,
  MOVE_LIMIT,
  moveSelection,
  previewDelete,
} from '@/lib/media/selection';
import { viewablePages } from '@/lib/media/usages';
import { ENABLED_VISIBILITIES } from '@/lib/r2/client';

import { MEDIA_ROUTE_TIMEOUT_SECONDS } from './limits';

/** Read by this route, not by the data-table parser, which refuses unknown keys. */
const OWN_PARAMS = ['folder', 'scope'] as const;

function dataTableUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of OWN_PARAMS) parsed.searchParams.delete(key);
  return parsed.href;
}

export const listMediaBinding = bind(listMedia, {
  permission: { resource: 'media', action: 'view' },
  rateLimit: { scope: 'media.get', limit: 120, by: 'user' },
  failure: mediaMsg.fetchError,
  // `scope` and `folder` keep their own messages; every other query refusal
  // reads as `parseDataTableParams` answers it.
  refusals: {
    query: {
      status: HTTP_STATUS.UNPROCESSABLE,
      unauthored: MSG_INVALID_FILTER,
    },
  },
  detail: {
    summary: 'List a media folder, or search the library',
    tags: ['Media'],
    parameters: dataTableParameters(MEDIA_FILTER_COLUMNS),
  },
  handler: async ({ query, actor, meta }) => {
    const scope = query.scope ?? 'folder';
    const folderId = query.folder ?? null;

    const { where, orderBy, limit, offset, search, paginationMeta } =
      parseDataTableParams(files, {
        url: dataTableUrl(meta.url),
        filterableColumns: MEDIA_FILTER_COLUMNS,
        searchableColumns: ['displayName'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const common = {
      visibilities: [...ENABLED_VISIBILITIES],
      canPublish: actor.permissions['media']?.['publish'] === true,
    };

    // Pending, deleting and record-held rows are never listed.
    const active = eq(files.status, 'active');
    const filter =
      scope === 'all'
        ? and(active, isNotNull(files.folderId), where)
        : scope === 'unfiled'
          ? and(unfiledNow(), where)
          : folderId === null
            ? null
            : and(active, eq(files.folderId, folderId), where);

    // Nothing below depends on another read but `toMediaFiles` on its rows, so
    // every branch awaits the page beside its own reads.
    const page = filter
      ? Promise.all([
          dataTableDb
            .select(FILE_COLUMNS)
            .from(files)
            .where(filter)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset)
            .then((rows) => toMediaFiles(rows)),
          dataTableDb
            .select({ total: count() })
            .from(files)
            .where(filter)
            .then(([row]) => row?.total ?? 0),
        ])
      : Promise.all([toMediaFiles([]), 0]);

    if (scope === 'all') {
      const [[listed, total], hits] = await Promise.all([
        page,
        search ? searchFolders(search) : { folders: [], truncated: false },
      ]);
      return {
        message: mediaMsg.fetched,
        data: {
          ...common,
          files: listed,
          folders: hits.folders,
          foldersTruncated: hits.truncated,
        },
        meta: paginationMeta(total),
      };
    }

    if (scope === 'unfiled') {
      const [listed, total] = await page;
      return {
        message: mediaMsg.fetched,
        data: {
          ...common,
          files: listed,
          retentionDays: UNFILED_RETENTION_DAYS,
        },
        meta: paginationMeta(total),
      };
    }

    // A missing folder lists nothing, so the reads beside its check are
    // harmless when it answers 404.
    const [[listed, total], trail, subfolders] = await Promise.all([
      page,
      folderId === null ? [] : breadcrumbs(folderId),
      listSubfolders(folderId),
      folderId === null ? undefined : requireFolder(folderId),
    ]);

    return {
      message: mediaMsg.fetched,
      data: {
        ...common,
        breadcrumbs: trail,
        folders: subfolders,
        files: listed,
      },
      meta: paginationMeta(total),
    };
  },
});

export const moveMediaBinding = bind(moveMedia, {
  permission: { resource: 'media', action: 'edit' },
  rateLimit: { ...MOVE_LIMIT, failClosed: true, by: 'user' },
  failure: mediaMsg.updateError,
  mapError: handleFolderForeignKeyViolation,
  detail: {
    summary: 'Move files and folders',
    description:
      'One transaction for the whole selection: every item moves under `to`, or nothing does. An item inside another selected folder is dropped from the selection, since it moves with that folder. `to: null` is the root, which holds folders only. A folder can be moved neither into itself nor below itself (`FOLDER_CYCLE`), nor so that the tree grows too deep (`FOLDER_TOO_DEEP`); a name already taken at the destination, or taken twice within the selection, is `FOLDER_NAME_EXISTS`. Each of those names the folders in `data.folderIds`; a file mid-visibility-change is `FILE_BUSY` with `data.fileIds`. The answer lists the ids actually re-parented: an item already at the destination, or carried by a selected folder, is not among them. Moving an unfiled file into a folder adopts it into the library.',
    tags: ['Media'],
  },
  handler: async ({ body, actor, meta }) => ({
    message: mediaMsg.updated,
    data: await moveSelection({
      fileIds: body.fileIds ?? [],
      folderIds: body.folderIds ?? [],
      to: body.to,
      actor: grantedActor(meta, actor),
    }),
  }),
});

export const deleteMediaBinding = bind(deleteMedia, {
  permission: { resource: 'media', action: 'delete' },
  rateLimit: { ...DELETE_LIMIT, failClosed: true, by: 'user' },
  failure: mediaMsg.deleteError,
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: {
    summary: 'Delete files and folders',
    description: `One transaction decides the whole selection: every file is committed to deletion and every folder removed, or nothing changes. Without \`recursive\`, a selected folder must hold nothing but uploads abandoned for ${ABANDONED_UPLOAD_MINUTES} minutes, which are deleted with it (\`FOLDER_NOT_EMPTY\` otherwise). With \`recursive: true\`, everything inside goes too, at most ${FOLDER_RECURSIVE_DELETE_MAX} items besides the selected folders themselves, selected files included (\`SELECTION_TOO_LARGE\`). An item inside another selected folder is dropped from the selection. Refused while a record references a file (\`FILE_IN_USE\`), while a file is changing visibility (\`FILE_BUSY\`), or while an upload younger than ${ABANDONED_UPLOAD_MINUTES} minutes is in a folder (\`FOLDER_BUSY\`); each names what blocked it in \`data\`. An \`own\`-scoped grant reaches only what the caller created or uploaded: a folder or an active file someone else made answers 404 and deletes nothing, while an upload in progress or abandoned counts as above whoever started it. \`folderIds\` lists every deleted folder, descendants included; \`deleted\` and \`pending\` split the files as on the file-only route.`,
    tags: ['Media'],
  },
  handler: async ({ body, actor, meta }) => ({
    message: mediaMsg.deleted,
    data: await deleteSelection({
      fileIds: body.fileIds ?? [],
      folderIds: body.folderIds ?? [],
      recursive: body.recursive === true,
      actor: grantedActor(meta, actor),
      viewable: viewablePages(actor.permissions),
    }),
  }),
});

/**
 * A read behind the delete grant, with the delete's own body and scope: what
 * it answers is what that caller's delete would meet.
 */
export const previewMediaDeleteBinding = bind(previewMediaDelete, {
  permission: { resource: 'media', action: 'delete' },
  rateLimit: { scope: 'media.delete-preview.post', limit: 60, by: 'user' },
  failure: mediaMsg.fetchError,
  detail: {
    summary: 'Preview a delete of files and folders',
    description: `The delete's own body, read the way the delete reads it, answered as data instead of refusals: what would go, and each list of blockers. Advisory, from a read-only snapshot with no lock: the delete decides again. Above ${FOLDER_RECURSIVE_DELETE_MAX} items \`exceedsLimit\` is true, the lists are \`null\` because they were not computed, and the counts are lower bounds. Scope failures answer 404, as the delete does.`,
    tags: ['Media'],
  },
  handler: async ({ body, actor, meta }) => ({
    message: mediaMsg.fetched,
    data: await previewDelete({
      fileIds: body.fileIds ?? [],
      folderIds: body.folderIds ?? [],
      recursive: body.recursive === true,
      actor: grantedActor(meta, actor),
    }),
  }),
});

export const getMediaStatsBinding = bind(getMediaStats, {
  permission: { resource: 'media', action: 'view' },
  rateLimit: { scope: 'media.stats.get', limit: 60, by: 'user' },
  failure: mediaMsg.fetchError,
  detail: { summary: 'Get the library totals', tags: ['Media'] },
  handler: async () => ({
    message: mediaMsg.fetched,
    data: await libraryTotals(),
  }),
});
