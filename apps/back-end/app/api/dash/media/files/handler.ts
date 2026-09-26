import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  deleteFilesSchema,
  moveFilesSchema,
} from '@app/shared/validation/media';

import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { moveFiles, toMediaFile } from '@/lib/media/files';
import { getFolder } from '@/lib/media/folders';
import { deleteFiles } from '@/lib/media/lifecycle';
import { mediaMsg } from '@/lib/media/messages';
import { DEFAULT_UPLOAD_PURPOSE } from '@/lib/media/policy';
import {
  admitUpload,
  chargeUploadBodyBudget,
  chargeUploadBudget,
  storeUpload,
  takeSingleFile,
  UPLOAD_ADMISSION_LIMIT,
  UPLOAD_ADMISSION_SCOPE,
} from '@/lib/media/upload';
import { viewablePages } from '@/lib/media/usages';
import { isVisibilityEnabled } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Library uploads land PRIVATE and only there: nothing done at upload time
 * makes a file public, and a deployment with no private bucket answers 422
 * rather than publishing what `media.create` alone may not publish.
 */
const LIBRARY_UPLOAD_VISIBILITY = 'private';

export const POST = withApiErrors(mediaMsg.uploadFailed, async (ctx) => {
  const caller = await requirePermission(ctx, {
    resource: 'media',
    action: 'create',
  });

  // Query, not form field, for the reason `resource` is one on
  // `/api/upload/file`: it is checked before the body is parsed.
  const folderId = requireId(ctx.query.get('folder'));
  if (!(await getFolder(folderId)))
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

  if (!isVisibilityEnabled(LIBRARY_UPLOAD_VISIBILITY))
    throw new CustomError(
      mediaMsg.visibilityDisabled,
      HTTP_STATUS.UNPROCESSABLE
    );

  await enforceRateLimit({
    scope: UPLOAD_ADMISSION_SCOPE,
    identifier: userIdentifier(caller.userId),
    limit: UPLOAD_ADMISSION_LIMIT,
    failClosed: true,
  });

  // Charged from `Content-Length` while the body is still a stream: the kind
  // budgets below can only be charged once it has been buffered.
  await chargeUploadBodyBudget(caller.userId, ctx.headers);

  const entry = takeSingleFile(await ctx.readFormData(), 'file');
  const admitted = await admitUpload(entry, DEFAULT_UPLOAD_PURPOSE);
  await chargeUploadBudget(caller.userId, admitted);

  const row = await storeUpload({
    admitted,
    target: {
      visibility: LIBRARY_UPLOAD_VISIBILITY,
      kinds: DEFAULT_UPLOAD_PURPOSE.kinds,
      folderId,
      activate: true,
    },
    actor: requestActor(ctx, caller),
  });

  return apiSuccess({
    message: mediaMsg.uploaded,
    data: await toMediaFile(row),
    status: HTTP_STATUS.CREATED,
  });
});

export const PUT = withApiErrors(
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
      actor: requestActor(ctx, caller, caller.scope ?? 'all'),
    });

    return apiSuccess({
      message: mediaMsg.updated,
      data: { unfiledAt: null, updatedAt },
    });
  },
  handleFolderForeignKeyViolation
);

export const DELETE = withApiErrors(mediaMsg.deleteError, async (ctx) => {
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
    actor: requestActor(ctx, caller, caller.scope ?? 'all'),
    viewable: viewablePages(caller.permissions),
  });

  return apiSuccess({
    message: mediaMsg.deleted,
    data: { deleted, pending },
  });
});
