import type { FileKind } from '@app/shared/validation/enums';

import {
  FILE_TOO_LARGE_CODE,
  FILE_TYPE_NOT_ALLOWED_CODE,
} from '@app/shared/error-codes';
import { sanitizeFilename } from '@app/shared/filename';
import { HTTP_STATUS } from '@app/shared/http-status';
import { SVG_MIME_TYPE } from '@app/shared/images/config';
import {
  MSG_DOCUMENT_TOO_LARGE,
  MSG_FILE_TOO_LARGE,
  MSG_FILE_TYPE_NOT_ALLOWED,
  MSG_MAX_FILES,
  MSG_NO_FILES,
  MSG_NO_VALID_FILES,
  MSG_UNEXPECTED_FORM_FIELD,
} from '@app/shared/messages/media';
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

import { fail } from './http';

/** The server's `fileTypeFor`: an allowed type's spec, by its normalized name. */
const fileTypeFor = (mimeType: string) =>
  ALLOWED_MIME_TYPES.includes(mimeType)
    ? [...MEDIA_TYPE_TABLE].find(([mime]) => mime === mimeType)?.[1]
    : undefined;

/**
 * A data URL, not a blob URL: a saved record still shows it after a reload.
 * Built in chunks: one `fromCodePoint` per byte is quadratic on a large file.
 */
export async function toDataUrl(file: File, type: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x80_00;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCodePoint(...bytes.subarray(i, i + CHUNK));
  return `data:${type};base64,${btoa(binary)}`;
}

/** `null` for a body that is not multipart, as the server reads it. */
export const readFormData = (request: Request) =>
  request.formData().catch(() => null);

/**
 * The server's `takeSingleFile`: the one part under `field`, or the 400 the
 * server answers.
 */
export function takeSingleFile(
  form: FormData | null,
  field: string
): File | Response {
  if (!form) return fail(HTTP_STATUS.BAD_REQUEST, MSG_NO_FILES);
  for (const [name] of form)
    if (name !== field)
      return fail(
        HTTP_STATUS.BAD_REQUEST,
        MSG_UNEXPECTED_FORM_FIELD(sanitizeFilename(name))
      );
  const entries = form.getAll(field);
  if (entries.length === 0) return fail(HTTP_STATUS.BAD_REQUEST, MSG_NO_FILES);
  if (entries.length > 1)
    return fail(HTTP_STATUS.BAD_REQUEST, MSG_MAX_FILES(1));
  const [entry] = entries;
  return entry instanceof File
    ? entry
    : fail(HTTP_STATUS.BAD_REQUEST, MSG_NO_VALID_FILES);
}

export interface AdmittedUpload {
  kind: FileKind;
  /** The type as the browser declared it, which the server normalizes. */
  declared: string;
  /** What is stored: a raster is re-encoded to WebP. */
  mimeType: string;
  displayName: string;
}

/**
 * The server's checks in its order, without the byte inspection, the image
 * pipeline or the rate limits: type, then size. Rasters are answered as the
 * WebP the server stores, though their bytes stay as sent.
 */
export function admitUpload(file: File): AdmittedUpload | Response {
  const safeName = sanitizeFilename(file.name);
  const declared = normalizeMimeType(file.type);
  const spec = fileTypeFor(declared);
  if (!spec)
    return fail(
      HTTP_STATUS.BAD_REQUEST,
      MSG_FILE_TYPE_NOT_ALLOWED(safeName),
      FILE_TYPE_NOT_ALLOWED_CODE
    );
  if (spec.kind === 'image' && file.size > MAX_IMAGE_SIZE * MIB)
    return fail(
      HTTP_STATUS.BAD_REQUEST,
      MSG_FILE_TOO_LARGE(safeName, MAX_IMAGE_SIZE),
      FILE_TOO_LARGE_CODE
    );
  if (spec.kind === 'document' && file.size > MAX_DOCUMENT_SIZE_MB * MIB)
    return fail(
      HTTP_STATUS.BAD_REQUEST,
      MSG_DOCUMENT_TOO_LARGE(safeName, MAX_DOCUMENT_SIZE_MB),
      FILE_TOO_LARGE_CODE
    );

  const isRaster = spec.kind === 'image' && declared !== SVG_MIME_TYPE;
  return {
    kind: spec.kind,
    declared,
    mimeType: isRaster ? 'image/webp' : declared,
    displayName: `${safeName}.${isRaster ? 'webp' : spec.extension}`,
  };
}
