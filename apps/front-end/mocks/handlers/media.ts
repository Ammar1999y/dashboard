import type { MediaFile } from '@/lib/files/upload';
import type { DashboardPage } from '@app/shared/permissions/constants';

import { http } from 'msw';
import { sanitizeFilename } from '@app/shared/filename';
import { HTTP_STATUS } from '@app/shared/http-status';
import { SVG_MIME_TYPE } from '@app/shared/images/config';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import {
  MSG_DOCUMENT_TOO_LARGE,
  MSG_FILE_TOO_LARGE,
  MSG_FILE_TYPE_NOT_ALLOWED,
  MSG_FILE_UPLOADED,
  MSG_INVALID_UPLOAD_PURPOSE,
  MSG_INVALID_UPLOAD_RESOURCE,
  MSG_MAX_FILES,
  MSG_NO_FILES,
  MSG_NO_VALID_FILES,
  MSG_UNEXPECTED_FORM_FIELD,
  MSG_UPLOAD_FAILED,
} from '@app/shared/messages/media';
import { DASHBOARD_PAGE_NAMES } from '@app/shared/permissions/constants';
import {
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_SIZE,
  MIB,
} from '@app/shared/validation/constants';
import {
  ALLOWED_MIME_TYPES,
  MEDIA_TYPE_TABLE,
  normalizeMimeType,
} from '@app/shared/validation/media-types';
import { UPLOAD_FIELD, UPLOAD_PATH } from '@/lib/files/upload';

import { generateEntityId } from '@/utils/generate-id';

import { now } from '../lib/db';
import { api, errorResponse, fail, ok } from '../lib/http';
import { denied } from '../lib/permissions';
import { currentUser, session } from '../store';

const isDashboardPage = (value: string | null): value is DashboardPage =>
  (DASHBOARD_PAGE_NAMES as readonly (string | null)[]).includes(value);

/** The server's `fileTypeFor`: an allowed type's spec, by its normalized name. */
const fileTypeFor = (mimeType: string) =>
  ALLOWED_MIME_TYPES.includes(mimeType)
    ? [...MEDIA_TYPE_TABLE].find(([mime]) => mime === mimeType)?.[1]
    : undefined;

/**
 * A data URL, not a blob URL: a saved record still shows it after a reload.
 * Built in chunks: one `fromCodePoint` per byte is quadratic on a large file.
 */
async function toDataUrl(file: File, type: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x80_00;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK));
  return `data:${type};base64,${btoa(binary)}`;
}

/** `null` for a body that is not multipart, as the server reads it. */
const readFormData = (request: Request) => request.formData().catch(() => null);

/**
 * The server's `takeSingleFile`: the one part under `UPLOAD_FIELD`, or the
 * 400 the server answers.
 */
function takeSingleFile(form: FormData | null): File | Response {
  if (!form) return fail(HTTP_STATUS.BAD_REQUEST, MSG_NO_FILES);
  for (const [name] of form)
    if (name !== UPLOAD_FIELD)
      return fail(
        HTTP_STATUS.BAD_REQUEST,
        MSG_UNEXPECTED_FORM_FIELD(sanitizeFilename(name))
      );
  const entries = form.getAll(UPLOAD_FIELD);
  if (entries.length === 0) return fail(HTTP_STATUS.BAD_REQUEST, MSG_NO_FILES);
  if (entries.length > 1)
    return fail(HTTP_STATUS.BAD_REQUEST, MSG_MAX_FILES(1));
  const [entry] = entries;
  return entry instanceof File
    ? entry
    : fail(HTTP_STATUS.BAD_REQUEST, MSG_NO_VALID_FILES);
}

/**
 * The server's checks in its order, without the byte inspection, the image
 * pipeline or the rate limits. Rasters are answered as the WebP the server
 * stores, though their bytes stay as sent.
 */
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

  const file = takeSingleFile(await readFormData(request));
  if (file instanceof Response) return file;

  const safeName = sanitizeFilename(file.name);
  const declared = normalizeMimeType(file.type);
  const spec = fileTypeFor(declared);
  if (!spec)
    return fail(HTTP_STATUS.BAD_REQUEST, MSG_FILE_TYPE_NOT_ALLOWED(safeName));
  if (spec.kind === 'image' && file.size > MAX_IMAGE_SIZE * MIB)
    return fail(
      HTTP_STATUS.BAD_REQUEST,
      MSG_FILE_TOO_LARGE(safeName, MAX_IMAGE_SIZE)
    );
  if (spec.kind === 'document' && file.size > MAX_DOCUMENT_SIZE_MB * MIB)
    return fail(
      HTTP_STATUS.BAD_REQUEST,
      MSG_DOCUMENT_TOO_LARGE(safeName, MAX_DOCUMENT_SIZE_MB)
    );

  const isRaster = spec.kind === 'image' && declared !== SVG_MIME_TYPE;
  const timestamp = now();
  const media: MediaFile & Record<string, unknown> = {
    id: generateEntityId(),
    kind: spec.kind,
    displayName: `${safeName}.${isRaster ? 'webp' : spec.extension}`,
    mimeType: isRaster ? 'image/webp' : declared,
    sizeBytes: file.size,
    bucketType: 'private',
    transition: null,
    width: null,
    height: null,
    blurhash: null,
    folderId: null,
    uploadedBy: currentUser()?.id ?? null,
    unfiledAt: null,
    url: await toDataUrl(file, declared),
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
