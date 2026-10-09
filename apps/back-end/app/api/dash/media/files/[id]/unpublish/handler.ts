import { mediaMsg } from '@app/shared/messages/media';

import { requireId } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { fileNotFound } from '@/lib/media/errors';
import { toMediaFile } from '@/lib/media/files';
import { transitionFile } from '@/lib/media/visibility';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Public → private, the mirror of `publish` under the same grant; the saga
 * refuses while a public owner still references the file. Its own limit, far
 * below publish's: each unpublish spends cache purges from the deployment-wide
 * budget in `lib/cloudflare/purge.ts`, which a few users at publish's rate
 * would exhaust.
 */
export const POST = withApiErrors(
  'POST /api/dash/media/files/:id/unpublish',
  mediaMsg.updateError,
  async (ctx) => {
    const caller = await requirePermission(ctx, {
      resource: 'media',
      action: 'publish',
      forceDB: true,
    });

    await enforceRateLimit({
      scope: 'media.files.unpublish',
      identifier: userIdentifier(caller.userId),
      limit: 10,
      failClosed: true,
    });

    const id = requireId(ctx.params.id, fileNotFound);

    const row = await transitionFile({
      id,
      to: 'private',
      actor: requestActor(ctx, caller, 'all'),
    });

    return apiSuccess({
      message: mediaMsg.unpublished,
      data: await toMediaFile(row),
    });
  }
);
