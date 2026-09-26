import { HTTP_STATUS } from '@app/shared/api-messages';
import { createFolderSchema } from '@app/shared/validation/media';

import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { createFolder } from '@/lib/media/folders';
import { mediaMsg } from '@/lib/media/messages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const POST = withApiErrors(mediaMsg.updateError, async (ctx) => {
  const caller = await requirePermission(ctx, {
    resource: 'media',
    action: 'create',
  });

  await enforceRateLimit({
    scope: 'media.folders.post',
    identifier: userIdentifier(caller.userId),
    limit: 30,
    failClosed: true,
  });

  const input = await readJsonBody(ctx, createFolderSchema);

  const folder = await createFolder({
    parentId: input.parentId ?? null,
    name: input.name,
    actor: requestActor(ctx, caller, 'all'),
  });

  return apiSuccess({
    message: mediaMsg.folderCreated,
    data: { id: folder.id, name: folder.name },
    status: HTTP_STATUS.CREATED,
  });
});
