import { uploadRecordFile } from '@app/shared/api/media';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { mediaMsg } from '@app/shared/messages/media';
import { RECORD_UPLOAD_FIELD } from '@app/shared/validation/media';

import { bind } from '@/lib/http/binding';
import { requireAnyPermission } from '@/lib/http/session';
import { requestActor } from '@/lib/media/actor';
import { toMediaFile } from '@/lib/media/files';
import { resolveUploadPurpose } from '@/lib/media/policy';
import { acceptUpload } from '@/lib/media/upload';

import { MEDIA_ROUTE_TIMEOUT_SECONDS, UPLOAD_ADMISSION } from './limits';

/**
 * Authorised against the resource the file is FOR: a standalone "may upload"
 * grant would let its holder attach files to a resource they cannot otherwise
 * touch.
 */
const UPLOAD_ACTIONS = ['create', 'edit'] as const;

/**
 * The gate checks the session; the grant depends on `resource`, so the handler
 * checks it, and `resource` is validated only after the session so an
 * anonymous caller cannot tell real page names from unknown ones.
 */
export const uploadRecordFileBinding = bind(uploadRecordFile, {
  rateLimit: UPLOAD_ADMISSION,
  failure: mediaMsg.uploadFailed,
  // Every query refusal is a 400, not the usual 422: this route's contract
  // keeps it. A bad `resource` keeps its own message.
  refusals: { query: { status: HTTP_STATUS.BAD_REQUEST } },
  // Image processing, then the upload itself.
  timeoutSeconds: MEDIA_ROUTE_TIMEOUT_SECONDS,
  detail: {
    summary: 'Upload a file for a dashboard record',
    tags: ['Uploads'],
  },
  handler: async ({ query, actor, meta }) => {
    const caller = await requireAnyPermission(
      meta,
      { resource: query.resource, actions: UPLOAD_ACTIONS },
      actor
    );

    // After the permission check, like the grant: an unauthorised caller must
    // not learn which purposes exist.
    const purpose = resolveUploadPurpose(query.resource, query.purpose ?? null);
    if (!purpose)
      throw new CustomError(mediaMsg.invalidPurpose, HTTP_STATUS.BAD_REQUEST);

    const row = await acceptUpload(
      meta,
      requestActor(meta, caller),
      {
        field: RECORD_UPLOAD_FIELD,
        visibility: purpose.visibility,
        kinds: purpose.kinds,
        folderId: null,
        activate: false,
      },
      meta.chargeRateLimit
    );

    return { message: mediaMsg.uploaded, data: [await toMediaFile(row)] };
  },
});
