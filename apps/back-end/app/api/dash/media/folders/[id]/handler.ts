import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { updateFolderSchema } from '@app/shared/validation/media';

import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { grantedActor } from '@/lib/media/actor';
import { folderNotFound } from '@/lib/media/errors';
import { folderDetails, updateFolder } from '@/lib/media/folders';
import { DELETE_LIMIT, deleteSelection } from '@/lib/media/selection';
import { viewablePages } from '@/lib/media/usages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Only `recursive=true` deletes the subtree; any other value the client might
 * have meant by it is a 422, not a silently narrower delete.
 */
const NOT_RECURSIVE = new Set([null, '', 'false']);

function requireRecursive(query: URLSearchParams): boolean {
  const raw = query.get('recursive');
  if (NOT_RECURSIVE.has(raw)) return false;
  if (raw !== 'true')
    throw new CustomError(mediaMsg.invalidRecursive, HTTP_STATUS.UNPROCESSABLE);
  return true;
}

export const GET = withApiErrors(
  'GET /api/dash/media/folders/:id',
  mediaMsg.fetchError,
  async (ctx) => {
    const { userId } = await requirePermission(ctx, {
      resource: 'media',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'media.folders.id.get',
      identifier: userIdentifier(userId),
      limit: 120,
    });

    const folderId = requireId(ctx.params.id, folderNotFound);

    return apiSuccess({
      message: mediaMsg.fetched,
      data: await folderDetails(folderId),
    });
  }
);

export const PUT = withApiErrors(
  'PUT /api/dash/media/folders/:id',
  mediaMsg.updateError,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'edit',
    });

    await enforceRateLimit({
      scope: 'media.folders.id.put',
      identifier: userIdentifier(caller.userId),
      limit: 30,
      failClosed: true,
    });

    const folderId = requireId(ctx.params.id, folderNotFound);

    const input = await readJsonBody(ctx, updateFolderSchema);

    const folder = await updateFolder({
      folderId,
      name: input.name,
      parentId: input.parentId,
      actor: grantedActor(ctx, caller),
    });

    return apiSuccess({
      message: mediaMsg.updated,
      data: {
        ...(input.name !== undefined && { name: folder.name }),
        updatedAt: folder.updatedAt,
      },
    });
  }
);

export const DELETE = withApiErrors(
  'DELETE /api/dash/media/folders/:id',
  mediaMsg.deleteError,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'delete',
    });

    await enforceRateLimit({
      ...DELETE_LIMIT,
      identifier: userIdentifier(caller.userId),
      failClosed: true,
    });

    const folderId = requireId(ctx.params.id, folderNotFound);
    const recursive = requireRecursive(ctx.query);

    const outcome = await deleteSelection({
      fileIds: [],
      folderIds: [folderId],
      recursive,
      actor: grantedActor(ctx, caller),
      viewable: viewablePages(caller.permissions),
    });

    return apiSuccess({ message: mediaMsg.deleted, data: outcome });
  }
);
