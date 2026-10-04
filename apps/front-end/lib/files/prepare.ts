import type { InputType, Preparation } from './accept';
import type { FileKind } from '@app/shared/validation/enums';
import type { Options as CompressionOptions } from 'browser-image-compression';

import imageCompression from 'browser-image-compression';
import { optimize } from 'svgo/browser';
import { CustomError } from '@app/shared/error-class';
import { sanitizeFilename } from '@app/shared/filename';
import { HTTP_STATUS } from '@app/shared/http-status';
import { SVG_MIME_TYPE } from '@app/shared/images/config';
import { sanitizeSvg } from '@app/shared/images/svg-optimizer';
import { svgRefusalMessage } from '@app/shared/images/svg-refusal';
import { optimizeSvg } from '@app/shared/images/svgo-config';
import {
  MSG_ANIMATED_NOT_ALLOWED,
  MSG_DOCUMENT_TOO_LARGE,
  MSG_FILE_TOO_LARGE,
  MSG_FILE_TYPE_NOT_ALLOWED,
  MSG_IMAGE_TARGET_UNREACHABLE,
  MSG_IMAGE_TOO_MANY_PIXELS,
  MSG_KIND_NOT_ALLOWED_HERE,
  MSG_SVG_OPTIMIZE_FAILED,
  uploadMsg,
} from '@app/shared/messages/media';
import {
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  MIB,
} from '@app/shared/validation/constants';
import {
  MSG_FOR_FILE,
  MSG_IMAGE_UNSUPPORTED,
  MSG_SVG_CONVERSION_FAILED,
} from '@/constants/messages';

import { INPUT_MAX_SIZE_MB, inputTypeOf, resolveFileType } from './accept';
import { COMPRESSION_LIB_URL } from './config';
import { readImageHeader } from './image-header';
import { renderSvg } from './render-svg';

export type FileErrorReason =
  | 'unsupported-type'
  | 'kind-not-allowed'
  | 'too-large'
  | 'animated'
  /** The browser could not decode the image, or not re-encode it. */
  | 'undecodable'
  | 'invalid-svg';

/** A file `prepareFile` refuses. Callers branch on `reason`, never on the text. */
export class FileError extends CustomError {
  constructor(
    message: string,
    public reason: FileErrorReason
  ) {
    super(message, HTTP_STATUS.UNPROCESSABLE);
    this.name = 'FileError';
  }
}

export interface AdmittedFile {
  mimeType: string;
  spec: InputType;
}

/**
 * The server's checks that need no bytes, in its order (`admitUpload`): type,
 * kind, size. `kinds` omitted admits every kind. Throws a `FileError`.
 */
export function admitFile(
  file: File,
  kinds?: readonly FileKind[]
): AdmittedFile {
  const safeName = sanitizeFilename(file.name);
  const mimeType = resolveFileType(file);
  const spec = inputTypeOf(mimeType);
  if (!spec?.allowed)
    throw new FileError(
      MSG_FILE_TYPE_NOT_ALLOWED(safeName),
      'unsupported-type'
    );
  if (kinds && !kinds.includes(spec.kind))
    throw new FileError(
      MSG_FOR_FILE(safeName, MSG_KIND_NOT_ALLOWED_HERE),
      'kind-not-allowed'
    );

  const maxMB = INPUT_MAX_SIZE_MB[spec.preparation];
  if (file.size > maxMB * MIB)
    throw new FileError(
      spec.kind === 'document'
        ? MSG_DOCUMENT_TOO_LARGE(safeName, maxMB)
        : MSG_FILE_TOO_LARGE(safeName, maxMB),
      'too-large'
    );
  return { mimeType, spec };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

const withExtension = (name: string, extension: string) =>
  `${name.replace(/\.[^.]+$/, '')}.${extension}`;

/**
 * An SVG outside the native form, rendered to an image and prepared as any
 * raster is. From the original source: the native cleanup would already have
 * changed the artwork. A failure is the user's to fix; the SVG is never sent.
 */
async function convertSvg(
  file: File,
  source: string,
  { signal, onConverted }: PrepareOptions
): Promise<File> {
  const safeName = sanitizeFilename(file.name);
  let png: Blob;
  try {
    png = await renderSvg(source, COMPRESSED_MAX_EDGE, CONVERTED_MIN_EDGE);
  } catch {
    throw new FileError(MSG_SVG_CONVERSION_FAILED(safeName), 'undecodable');
  }
  throwIfAborted(signal);

  const prepared = await compressImage(
    new File([png], withExtension(file.name, 'png'), {
      type: 'image/png',
      lastModified: Date.now(),
    }),
    signal
  );
  onConverted?.(safeName);
  return prepared;
}

async function prepareSvg(file: File, options: PrepareOptions): Promise<File> {
  const source = await file.text();
  // Nothing interrupts a render once started, so an abort is honoured first.
  throwIfAborted(options.signal);
  const result = sanitizeSvg(source);
  if (result.reason === 'requires-conversion')
    return convertSvg(file, source, options);
  if (!result.isValid) {
    // Given the raw name: it sanitizes the name itself.
    const message = svgRefusalMessage(result.reason, file.name);
    throw result.reason === 'animated'
      ? new FileError(message, 'animated')
      : new FileError(
          MSG_FOR_FILE(sanitizeFilename(file.name), message),
          'invalid-svg'
        );
  }

  const optimized = optimizeSvg(result.cleanedSvg, optimize);
  if (optimized === null)
    throw new FileError(
      MSG_FOR_FILE(sanitizeFilename(file.name), MSG_SVG_OPTIMIZE_FAILED),
      'invalid-svg'
    );

  return new File([optimized], file.name, {
    type: SVG_MIME_TYPE,
    lastModified: Date.now(),
  });
}

/**
 * The server's header checks, by signature rather than declared type: the
 * canvas decodes whatever the bytes are, flattens an animation and allocates
 * whatever size the header states.
 */
function inspectRaster(bytes: Uint8Array, safeName: string) {
  const header = readImageHeader(bytes);
  if (header === null)
    throw new FileError(
      uploadMsg.contentMismatch(safeName),
      'unsupported-type'
    );
  if (header.animated)
    throw new FileError(MSG_ANIMATED_NOT_ALLOWED(safeName), 'animated');

  const { size } = header;
  if (size === null)
    throw new FileError(
      MSG_FOR_FILE(safeName, uploadMsg.undecodable),
      'undecodable'
    );
  if (size.width * size.height > MAX_IMAGE_PIXELS)
    throw new FileError(
      MSG_FOR_FILE(
        safeName,
        MSG_IMAGE_TOO_MANY_PIXELS(Math.floor(MAX_IMAGE_PIXELS / 1_000_000))
      ),
      'too-large'
    );
}

const OUTPUT_FORMATS = [
  { type: 'image/webp', extension: 'webp' },
  { type: 'image/png', extension: 'png' },
] as const;

/** The longest side of every image `prepareFile` encodes, converted SVGs included. */
export const COMPRESSED_MAX_EDGE = 2048;

/**
 * The longest side a converted SVG is drawn at, at least: the source is a
 * vector, and an icon drawn at its own 24 px would be stored at 24 px.
 */
export const CONVERTED_MIN_EDGE = 1024;

/**
 * `libURL` is absolute: the library's worker runs from a `blob:` URL, against
 * which a path resolves to nothing, and when its `importScripts` fails the
 * library compresses on the main thread instead, freezing the page.
 */
export const compressionOptions = (): CompressionOptions => ({
  maxWidthOrHeight: COMPRESSED_MAX_EDGE,
  maxSizeMB: MAX_IMAGE_SIZE,
  initialQuality: 0.95,
  useWebWorker: true,
  libURL: new URL(COMPRESSION_LIB_URL, location.origin).href,
});

/**
 * Re-encodes to WebP, else PNG, under the server's image ceiling. The library
 * returns its last attempt even when that is still over the ceiling, so the
 * size is checked here.
 */
async function compressImage(file: File, signal?: AbortSignal): Promise<File> {
  const safeName = sanitizeFilename(file.name);
  inspectRaster(new Uint8Array(await file.arrayBuffer()), safeName);

  for (const format of OUTPUT_FORMATS) {
    // The library's worker never settles for a signal aborted before the call.
    throwIfAborted(signal);
    let compressed: Blob;
    try {
      compressed = await imageCompression(file, {
        ...compressionOptions(),
        fileType: format.type,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      continue;
    }
    if (compressed.type !== format.type) continue;
    if (compressed.size > MAX_IMAGE_SIZE * MIB)
      throw new FileError(
        MSG_FOR_FILE(safeName, MSG_IMAGE_TARGET_UNREACHABLE),
        'too-large'
      );

    return new File([compressed], withExtension(file.name, format.extension), {
      type: format.type,
      lastModified: Date.now(),
    });
  }
  throw new FileError(MSG_IMAGE_UNSUPPORTED(safeName), 'undecodable');
}

const PREPARE: Readonly<
  Record<Preparation, (file: File, options: PrepareOptions) => Promise<File>>
> = {
  svg: prepareSvg,
  raster: (file, { signal }) => compressImage(file, signal),
  document: (file) => Promise.resolve(file),
};

/** What this module produced: preparing it again would re-encode it. */
const preparedFiles = new WeakSet<File>();

export interface PrepareOptions {
  signal?: AbortSignal;
  /** The kinds the caller takes here; omitted, every kind. */
  kinds?: readonly FileKind[];
  /**
   * Called with the file's display name when an SVG outside the native form
   * was rendered to an image; the caller tells the user.
   */
  onConverted?: (safeName: string) => void;
}

/**
 * What an upload sends: an SVG sanitized and optimized, or rendered to an image
 * when it is outside the native form, a raster image
 * re-encoded under the server's ceiling, a document size-checked, each under
 * the one type `resolveFileType` gives it. Anything else is refused. Rejects
 * with a `FileError`, or rethrows an abort; callers must not fall back to the
 * original file. A file this returned is returned as it is.
 */
export async function prepareFile(
  file: File,
  options: PrepareOptions = {}
): Promise<File> {
  const { mimeType, spec } = admitFile(file, options.kinds);
  if (preparedFiles.has(file)) return file;
  throwIfAborted(options.signal);

  // The compressor refuses an empty type, and the server reads the declared one.
  const typed =
    file.type === mimeType
      ? file
      : new File([file], file.name, {
          type: mimeType,
          lastModified: file.lastModified,
        });
  const prepared = await PREPARE[spec.preparation](typed, options);
  preparedFiles.add(prepared);
  return prepared;
}
