import type { LibraryFile } from '@/lib/media/schemas';
import type { DashboardPage } from '@app/shared/permissions/constants';

import { http } from 'msw';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import {
  MSG_FILE_UPLOADED,
  MSG_INVALID_UPLOAD_PURPOSE,
  MSG_INVALID_UPLOAD_RESOURCE,
  MSG_UPLOAD_FAILED,
} from '@app/shared/messages/media';
import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';
import { UPLOAD_FIELD, UPLOAD_PATH } from '@/lib/files/upload';

import { generateEntityId } from '@/utils/generate-id';

import { now } from '../lib/db';
import { api, errorResponse, fail, ok } from '../lib/http';
import { denied } from '../lib/permissions';
import {
  admitUpload,
  readFormData,
  takeSingleFile,
  toDataUrl,
} from '../lib/upload';
import { currentUser, session } from '../store';

const isDashboardPage = (value: string | null): value is DashboardPage =>
  (DASHBOARD_PAGE_NAMES as readonly (string | null)[]).includes(value);

/** The record upload route, as the server admits files. */
async function upload(request: Request): Promise<Response> {
  if (!session.get()) return fail(HTTP_STATUS.UNAUTHORIZED, MSG_LOGIN_REQUIRED);

  const query = new URL(request.url).searchParams;
  const resource = query.get('resource');
  if (!isDashboardPage(resource))
    return fail(HTTP_STATUS.BAD_REQUEST, MSG_INVALID_UPLOAD_RESOURCE);
  const refused = denied(resource, ['create', 'edit']);
  if (refused) return refused;
  // The back-end's `UPLOAD_PURPOSES` is empty, so every named purpose is unknown.
  if (query.has('purpose'))
    return fail(HTTP_STATUS.BAD_REQUEST, MSG_INVALID_UPLOAD_PURPOSE);

  const file = takeSingleFile(await readFormData(request), UPLOAD_FIELD);
  if (file instanceof Response) return file;
  const admitted = admitUpload(file);
  if (admitted instanceof Response) return admitted;

  const timestamp = now();
  const uploader = currentUser();
  const media: LibraryFile = {
    id: generateEntityId(),
    kind: admitted.kind,
    displayName: admitted.displayName,
    mimeType: admitted.mimeType,
    sizeBytes: file.size,
    bucketType: 'private',
    transition: null,
    width: null,
    height: null,
    blurhash: null,
    folderId: null,
    uploadedBy: uploader?.id ?? null,
    uploadedByName: uploader?.name ?? null,
    unfiledAt: null,
    inUse: false,
    url: await toDataUrl(file, admitted.declared),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return ok([media], MSG_FILE_UPLOADED, HTTP_STATUS.CREATED);
}

export const mediaHandlers = [
  // The route's own fallback, which the registration wrapper's POST default is not.
  http.post(api(UPLOAD_PATH), ({ request }) =>
    upload(request).catch((error: unknown) =>
      errorResponse(error, MSG_UPLOAD_FAILED)
    )
  ),
];
