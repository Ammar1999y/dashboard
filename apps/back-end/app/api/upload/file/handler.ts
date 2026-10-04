import type { DashboardPage } from '@app/shared/permissions/constants';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg, uploadMsg } from '@app/shared/messages/media';
import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';

import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireAnyPermission, requireSession } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { toMediaFile } from '@/lib/media/files';
import { resolveUploadPurpose } from '@/lib/media/policy';
import {
  acceptUpload,
  UPLOAD_ADMISSION_LIMIT,
  UPLOAD_ADMISSION_SCOPE,
} from '@/lib/media/upload';
import { isVisibilityEnabled } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

/**
 * Authorised against the resource the file is FOR: a standalone "may upload"
 * grant would let its holder attach files to a resource they cannot otherwise
 * touch.
 */
const UPLOAD_ACTIONS = ['create', 'edit'] as const;

/**
 * From the QUERY STRING: the permission check must run before `readFormData()`
 * parses the body it guards.
 *
 * ⚠️ Only after the session check, or an unauthenticated caller could tell real
 * page names (401) from unknown ones (400).
 */
function requireUploadResource(query: URLSearchParams): DashboardPage {
  const requested = query.get('resource');
  const resource = DASHBOARD_PAGE_NAMES.find((page) => page === requested);
  if (!resource)
    throw new CustomError(uploadMsg.invalidResource, HTTP_STATUS.BAD_REQUEST);
  return resource;
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

  // Per USER: an IP bucket lets one account spend its NAT neighbours' budget.
  // The coarse per-IP bound runs earlier, in the adapter.
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
