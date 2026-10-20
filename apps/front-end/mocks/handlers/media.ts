import type { LibraryFile } from '@/lib/media/schemas';
import type { DashboardPage } from '@app/shared/permissions/constants';

import { uploadRecordFile } from '@app/shared/api/media';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import {
  MSG_FILE_UPLOADED,
  MSG_INVALID_UPLOAD_PURPOSE,
  MSG_INVALID_UPLOAD_RESOURCE,
  MSG_UPLOAD_FAILED,
} from '@app/shared/messages/media';
import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';
import { RECORD_UPLOAD_FIELD } from '@app/shared/validation/media';

import { generateEntityId } from '@/utils/generate-id';

import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { failingAs } from '../lib/http';
import { requireAnyAction } from '../lib/permissions';
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
async function upload(request: Request, query: URLSearchParams) {
  if (!session.get())
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  const resource = query.get('resource');
  if (!isDashboardPage(resource))
    throw new CustomError(MSG_INVALID_UPLOAD_RESOURCE, HTTP_STATUS.BAD_REQUEST);
  requireAnyAction(resource, ['create', 'edit']);
  // The back-end's `UPLOAD_PURPOSES` is empty, so every named purpose is unknown.
  if (query.has('purpose'))
    throw new CustomError(MSG_INVALID_UPLOAD_PURPOSE, HTTP_STATUS.BAD_REQUEST);

  const file = takeSingleFile(await readFormData(request), RECORD_UPLOAD_FIELD);
  const admitted = admitUpload(file);

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
  return { message: MSG_FILE_UPLOADED, data: [media] };
}

export const mediaHandlers = [
  // The route's own fallback, which the registration wrapper's POST default is not.
  mock(uploadRecordFile, ({ request, query }) =>
    upload(request, query).catch(failingAs(MSG_UPLOAD_FAILED))
  ),
];
