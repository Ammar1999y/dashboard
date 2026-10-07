import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import {
  deleteFilesSchema,
  moveFilesSchema,
} from '@app/shared/validation/media';

import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { grantedActor, requestActor } from '@/lib/media/actor';
import { moveFiles, toMediaFile } from '@/lib/media/files';
import { requireFolder } from '@/lib/media/folders';
import { deleteFiles } from '@/lib/media/lifecycle';
import { DEFAULT_UPLOAD_PURPOSE } from '@/lib/media/policy';
import { acceptUpload } from '@/lib/media/upload';
import { viewablePages } from '@/lib/media/usages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Nothing done at upload time makes a file public: with no private bucket this
 * answers 422 rather than publish what `media.create` alone may not.
 */
const LIBRARY_UPLOAD_VISIBILITY = 'private';

export const POST = withApiErrors(
  'POST /api/dash/media/files',
  mediaMsg.uploadFailed,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'create',
    });

    // Query, not form field: it is checked before the body is parsed.
    const folderId = requireId(ctx.query.get('folder'));
    await requireFolder(folderId);

    const row = await acceptUpload(ctx, requestActor(ctx, caller), {
      field: 'file',
      visibility: LIBRARY_UPLOAD_VISIBILITY,
      kinds: DEFAULT_UPLOAD_PURPOSE.kinds,
      folderId,
      activate: true,
    });

    return apiSuccess({
      message: mediaMsg.uploaded,
      data: await toMediaFile(row),
      status: HTTP_STATUS.CREATED,
    });
  }
);

export const PUT = withApiErrors(
  'PUT /api/dash/media/files',
  mediaMsg.updateError,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'edit',
    });

    await enforceRateLimit({
      scope: 'media.files.put',
      identifier: userIdentifier(caller.userId),
      limit: 30,
      failClosed: true,
    });

    const input = await readJsonBody(ctx, moveFilesSchema);

    const updatedAt = await moveFiles({
      ids: input.ids,
      folderId: input.folderId,
      actor: grantedActor(ctx, caller),
    });

    return apiSuccess({
      message: mediaMsg.updated,
      data: { unfiledAt: null, updatedAt },
    });
  },
  handleFolderForeignKeyViolation
);

export const DELETE = withApiErrors(
  'DELETE /api/dash/media/files',
  mediaMsg.deleteError,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'delete',
    });

    await enforceRateLimit({
      scope: 'media.files.delete',
      identifier: userIdentifier(caller.userId),
      limit: 30,
      failClosed: true,
    });

    const input = await readJsonBody(ctx, deleteFilesSchema);

    const { deleted, pending } = await deleteFiles({
      ids: input.ids,
      actor: grantedActor(ctx, caller),
      viewable: viewablePages(caller.permissions),
    });

    return apiSuccess({
      message: mediaMsg.deleted,
      data: { deleted, pending },
    });
  }
);
