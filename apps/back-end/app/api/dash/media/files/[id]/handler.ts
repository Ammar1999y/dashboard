import { mediaMsg } from '@app/shared/messages/media';
import { updateFileSchema } from '@app/shared/validation/media';

import { handleFolderForeignKeyViolation } from '@/lib/http/constraint-errors';
import { readJsonBody, requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { grantedActor } from '@/lib/media/actor';
import { fileNotFound } from '@/lib/media/errors';
import {
  downloadUrl,
  findFile,
  previewUrl,
  toMediaFile,
  updateFile,
} from '@/lib/media/files';
import { signingWindow } from '@/lib/media/signing';
import { fileUsages, viewablePages } from '@/lib/media/usages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(
  'GET /api/dash/media/files/:id',
  mediaMsg.fetchError,
  async (ctx) => {
    const { userId, permissions } = await requirePermission(ctx, {
      resource: 'media',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'media.files.id.get',
      identifier: userIdentifier(userId),
      limit: 120,
    });

    const id = requireId(ctx.params.id, fileNotFound);

    const row = await findFile(id);
    // A pending or deleting row is not a file the library has; one a record
    // still holds is that record's, not the library's.
    if (!row || row.status !== 'active' || !row.governed) throw fileNotFound();

    const usages = await fileUsages(id, viewablePages(permissions));
    const inUse = usages.visibleCount + usages.hidden > 0;
    const window = signingWindow(Date.now());
    const [file, download, preview] = await Promise.all([
      toMediaFile(row, { usedIds: new Set(inUse ? [id] : []) }),
      downloadUrl(row, window),
      previewUrl(row, window),
    ]);

    return apiSuccess({
      message: mediaMsg.fetched,
      data: {
        ...file,
        downloadUrl: download,
        previewUrl: preview,
        usedBy: usages.visible,
        visibleUsages: usages.visibleCount,
        hiddenUsages: usages.hidden,
      },
    });
  }
);

export const PUT = withApiErrors(
  'PUT /api/dash/media/files/:id',
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

    const id = requireId(ctx.params.id, fileNotFound);

    const input = await readJsonBody(ctx, updateFileSchema);
    const updated = await updateFile({
      id,
      displayName: input.displayName,
      folderId: input.folderId,
      actor: grantedActor(ctx, caller),
    });

    return apiSuccess({
      message: mediaMsg.updated,
      data: {
        ...(input.displayName !== undefined && {
          displayName: updated.displayName,
        }),
        // `updateFile` files the row, which clears the stamp.
        ...(input.folderId !== undefined && { unfiledAt: null }),
        updatedAt: updated.updatedAt,
      },
    });
  },
  handleFolderForeignKeyViolation
);
