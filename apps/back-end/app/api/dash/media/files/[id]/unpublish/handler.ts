import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';

import { requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { toMediaFile } from '@/lib/media/files';
import { transitionFile } from '@/lib/media/visibility';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Public → private, the mirror of `publish`: same grant, one shared limiter
 * scope, and the saga refuses while a public owner still references the file.
 */
export const POST = withApiErrors(mediaMsg.updateError, async (ctx) => {
  const caller = await requirePermission(ctx, {
    resource: 'media',
    action: 'publish',
    forceDB: true,
  });

  await enforceRateLimit({
    scope: 'media.files.visibility',
    identifier: userIdentifier(caller.userId),
    limit: 10,
    failClosed: true,
  });

  const id = requireId(
    ctx.params.id,
    mediaMsg.fileNotFound,
    HTTP_STATUS.NOT_FOUND
  );

  const row = await transitionFile({
    id,
    to: 'private',
    actor: requestActor(ctx, caller, 'all'),
  });

  return apiSuccess({
    message: mediaMsg.unpublished,
    data: await toMediaFile(row),
  });
});
