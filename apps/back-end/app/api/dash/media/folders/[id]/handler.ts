import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { updateFolderSchema } from '@app/shared/validation/media';

import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { grantedActor } from '@/lib/media/actor';
import { deleteFolder, updateFolder } from '@/lib/media/folders';
import { deleteFolderTree } from '@/lib/media/lifecycle';
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

export const PUT = withApiErrors(mediaMsg.updateError, async (ctx) => {
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

  const folderId = requireId(
    ctx.params.id,
    mediaMsg.folderNotFound,
    HTTP_STATUS.NOT_FOUND
  );

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
});

export const DELETE = withApiErrors(mediaMsg.deleteError, async (ctx) => {
  const caller = await requirePermission(ctx, {
    resource: 'media',
    action: 'delete',
  });

  await enforceRateLimit({
    scope: 'media.folders.id.delete',
    identifier: userIdentifier(caller.userId),
    limit: 30,
    failClosed: true,
  });

  const folderId = requireId(
    ctx.params.id,
    mediaMsg.folderNotFound,
    HTTP_STATUS.NOT_FOUND
  );
  const recursive = requireRecursive(ctx.query);

  const actor = grantedActor(ctx, caller);
  const outcome = recursive
    ? await deleteFolderTree({
        folderId,
        actor,
        viewable: viewablePages(caller.permissions),
      })
    : await deleteFolder({ folderId, actor });

  return apiSuccess({ message: mediaMsg.deleted, data: outcome });
});
