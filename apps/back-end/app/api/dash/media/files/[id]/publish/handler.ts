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
 * Private → public. `publish` has no `Own` variant, so `resolveActionScope`
 * answers `scope: 'all'` and the uploader narrowing never applies: publishing
 * is an editorial decision about the file, not about who uploaded it.
 */
export const POST = withApiErrors(mediaMsg.updateError, async (ctx) => {
  const caller = await requirePermission(ctx, {
    resource: 'media',
    action: 'publish',
    // Not the cookie cache: this changes who on the internet can read the
    // object, so the grant behind it has to be the current one.
    forceDB: true,
  });

  // Two R2 calls and a HeadObject per file.
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
    to: 'public',
    actor: requestActor(ctx, caller, 'all'),
  });

  return apiSuccess({
    message: mediaMsg.published,
    data: await toMediaFile(row),
  });
});
