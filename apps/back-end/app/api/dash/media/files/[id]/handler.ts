import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { updateFileSchema } from '@app/shared/validation/media';

import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import {
  downloadUrl,
  findFile,
  toMediaFile,
  updateFile,
} from '@/lib/media/files';
import { mediaMsg } from '@/lib/media/messages';
import { usedBy, viewablePages } from '@/lib/media/usages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(mediaMsg.fetchError, async (ctx) => {
  const { userId, permissions } = await requirePermission(ctx, {
    resource: 'media',
    action: 'view',
  });

  await enforceRateLimit({
    scope: 'media.files.id.get',
    identifier: userIdentifier(userId),
    limit: 120,
  });

  const id = requireId(
    ctx.params.id,
    mediaMsg.fileNotFound,
    HTTP_STATUS.NOT_FOUND
  );

  const row = await findFile(id);
  // A pending or deleting row is not a file the library has; one a record
  // still holds is that record's, not the library's.
  if (!row || row.status !== 'active' || !row.governed)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

  const [file, download, usages] = await Promise.all([
    toMediaFile(row),
    downloadUrl(row),
    usedBy([id], viewablePages(permissions)),
  ]);
  const summary = usages.get(id) ?? { visible: [], hidden: 0 };

  return apiSuccess({
    message: mediaMsg.fetched,
    data: {
      ...file,
      downloadUrl: download,
      usedBy: summary.visible,
      hiddenUsages: summary.hidden,
    },
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
      scope: 'media.files.id.put',
      identifier: userIdentifier(caller.userId),
      limit: 30,
      failClosed: true,
    });

    const id = requireId(
      ctx.params.id,
      mediaMsg.fileNotFound,
      HTTP_STATUS.NOT_FOUND
    );

    const input = await readJsonBody(ctx, updateFileSchema);
    const updated = await updateFile({
      id,
      displayName: input.displayName,
      folderId: input.folderId,
      actor: requestActor(ctx, caller, caller.scope ?? 'all'),
    });

    return apiSuccess({
      message: mediaMsg.updated,
      data: {
        ...(input.displayName !== undefined && {
          displayName: updated.displayName,
        }),
        ...(input.folderId !== undefined && {
          unfiledAt: updated.unfiledAt,
        }),
        updatedAt: updated.updatedAt,
      },
    });
  },
  handleFolderForeignKeyViolation
);
