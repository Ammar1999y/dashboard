import type { MediaScope } from '@app/shared/validation/media';

import { and, count, eq, isNotNull } from 'drizzle-orm';

import { db } from '@/db';
import { files } from '@/db/schema';

import { MEDIA_FILTER_COLUMNS } from '@app/shared/data-table/filterable-columns';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { MEDIA_SCOPES } from '@app/shared/validation/media';

import { parseDataTableParams } from '@/lib/data-table/params';
import { requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { FILE_COLUMNS, toMediaFiles } from '@/lib/media/files';
import {
  breadcrumbs,
  listSubfolders,
  requireFolder,
  searchFolders,
} from '@/lib/media/folders';
import { UNFILED_RETENTION_DAYS, unfiledNow } from '@/lib/media/lifecycle';
import { ENABLED_VISIBILITIES } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/** Parameters this route reads itself; the data-table parser rejects unknown keys. */
const OWN_PARAMS = new Set(['folder', 'scope']);

function requireScope(query: URLSearchParams): MediaScope {
  const raw = query.get('scope') ?? 'folder';
  const scope = MEDIA_SCOPES.find((candidate) => candidate === raw);
  if (!scope)
    throw new CustomError(mediaMsg.invalidScope, HTTP_STATUS.UNPROCESSABLE);
  return scope;
}

/** `null` for the root; a malformed id is a 422, like every other id here. */
function requireFolderParam(query: URLSearchParams): string | null {
  const raw = query.get('folder');
  if (raw === null || raw === '') return null;
  return requireId(raw);
}

function dataTableUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of OWN_PARAMS) parsed.searchParams.delete(key);
  return parsed.href;
}

export const GET = withApiErrors(
  'GET /api/dash/media',
  mediaMsg.fetchError,
  async (ctx) => {
    const { userId, permissions } = await requirePermission(ctx, {
      resource: 'media',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'media.get',
      identifier: userIdentifier(userId),
      limit: 120,
    });

    const scope = requireScope(ctx.query);
    const folderId = requireFolderParam(ctx.query);

    const {
      where,
      orderBy,
      limit,
      offset,
      page,
      perPage,
      search,
      buildPageCount,
    } = parseDataTableParams(files, {
      url: dataTableUrl(ctx.url),
      filterableColumns: MEDIA_FILTER_COLUMNS,
      searchableColumns: ['displayName'],
      defaultSort: { id: 'createdAt', desc: true },
    });

    const common = {
      visibilities: [...ENABLED_VISIBILITIES],
      canPublish: permissions?.['media']?.['publish'] === true,
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

    if (scope === 'folder' && folderId !== null) await requireFolder(folderId);

    const [rows, [totalRow]] = filter
      ? await Promise.all([
          db
            .select(FILE_COLUMNS)
            .from(files)
            .where(filter)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset),
          db.select({ total: count() }).from(files).where(filter),
        ])
      : [[], [{ total: 0 }]];
    const total = totalRow?.total ?? 0;
    const meta = { page, perPage, total, pageCount: buildPageCount(total) };

    if (scope === 'all') {
      const hits = search
        ? await searchFolders(search)
        : { folders: [], truncated: false };
      return apiSuccess({
        message: mediaMsg.fetched,
        data: {
          ...common,
          files: await toMediaFiles(rows),
          folders: hits.folders,
          foldersTruncated: hits.truncated,
        },
        meta,
      });
    }

    if (scope === 'unfiled')
      return apiSuccess({
        message: mediaMsg.fetched,
        data: {
          ...common,
          files: await toMediaFiles(rows),
          retentionDays: UNFILED_RETENTION_DAYS,
        },
        meta,
      });

    const [trail, subfolders] = await Promise.all([
      folderId === null ? Promise.resolve([]) : breadcrumbs(folderId),
      listSubfolders(folderId),
    ]);

    return apiSuccess({
      message: mediaMsg.fetched,
      data: {
        ...common,
        breadcrumbs: trail,
        folders: subfolders,
        files: await toMediaFiles(rows),
      },
      meta,
    });
  }
);
