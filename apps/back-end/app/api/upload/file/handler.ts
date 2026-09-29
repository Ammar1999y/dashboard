import type { DashboardPage } from '@app/shared/permissions/constants';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { DASHBOARD_PAGES } from '@app/shared/permissions/constants';

import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireAnyPermission, requireSession } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { toMediaFile } from '@/lib/media/files';
import { mediaMsg, uploadMsg } from '@/lib/media/messages';
import { resolveUploadPurpose } from '@/lib/media/policy';
import {
  acceptUpload,
  UPLOAD_ADMISSION_LIMIT,
  UPLOAD_ADMISSION_SCOPE,
} from '@/lib/media/upload';
import { isVisibilityEnabled } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Authorised against the resource the file is FOR, not a permission of its
 * own: this endpoint owns no data, and a standalone "may upload" grant would
 * let its holder attach files to a resource they cannot otherwise touch. A
 * file is attached while creating a record or while editing one.
 */
const UPLOAD_ACTIONS = ['create', 'edit'] as const;

/**
 * Read from the QUERY STRING because the permission check has to run before
 * `readFormData()`, and a form field is only readable by parsing the body this
 * route guards. `Object.hasOwn`, because a bare `in` accepts `__proto__`.
 *
 * ⚠️ Call it only after the session check: before it, an unauthenticated caller
 * would get 400 for an unknown resource and 401 for a real page name.
 */
function requireUploadResource(query: URLSearchParams): DashboardPage {
  const requested = query.get('resource');
  if (!requested || !Object.hasOwn(DASHBOARD_PAGES, requested))
    throw new CustomError(uploadMsg.invalidResource, HTTP_STATUS.BAD_REQUEST);
  return requested as DashboardPage;
}

export const POST = withApiErrors(mediaMsg.uploadFailed, async (ctx) => {
  await requireSession(ctx);

  const resource = requireUploadResource(ctx.query);
  const caller = await requireAnyPermission(ctx, {
    resource,
    actions: UPLOAD_ACTIONS,
  });

  // After the permission check, like `resource`: an unauthorised caller must
  // not learn which purposes exist.
  const purpose = resolveUploadPurpose(resource, ctx.query.get('purpose'));
  if (!purpose)
    throw new CustomError(mediaMsg.invalidPurpose, HTTP_STATUS.BAD_REQUEST);
  if (!isVisibilityEnabled(purpose.visibility))
    throw new CustomError(
      mediaMsg.visibilityDisabled,
      HTTP_STATUS.UNPROCESSABLE
    );

  // Per USER: an IP bucket would let one account spend every colleague's
  // budget from a shared NAT egress. The coarse per-IP bound runs ahead of
  // this, in the adapter.
  await enforceRateLimit({
    scope: UPLOAD_ADMISSION_SCOPE,
    identifier: userIdentifier(caller.userId),
    limit: UPLOAD_ADMISSION_LIMIT,
    failClosed: true,
  });

  const row = await acceptUpload(ctx, requestActor(ctx, caller), {
    field: 'files',
    visibility: purpose.visibility,
    kinds: purpose.kinds,
    folderId: null,
    activate: false,
  });

  return apiSuccess({
    message: mediaMsg.uploaded,
    data: [await toMediaFile(row)],
    status: HTTP_STATUS.CREATED,
  });
});
