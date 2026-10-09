import { mediaMsg } from '@app/shared/messages/media';
import { mediaDeleteSelectionSchema } from '@app/shared/validation/media';

import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { grantedActor } from '@/lib/media/actor';
import { previewDelete } from '@/lib/media/selection';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * A read behind the delete grant, with the delete's own body and scope: what
 * it answers is what that caller's delete would meet.
 */
export const POST = withApiErrors(
  'POST /api/dash/media/delete-preview',
  mediaMsg.fetchError,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'delete',
    });

    await enforceRateLimit({
      scope: 'media.delete-preview.post',
      identifier: userIdentifier(caller.userId),
      limit: 60,
    });

    const input = await readJsonBody(ctx, mediaDeleteSelectionSchema);

    const preview = await previewDelete({
      fileIds: input.fileIds ?? [],
      folderIds: input.folderIds ?? [],
      recursive: input.recursive === true,
      actor: grantedActor(ctx, caller),
    });

    return apiSuccess({ message: mediaMsg.fetched, data: preview });
  }
);
