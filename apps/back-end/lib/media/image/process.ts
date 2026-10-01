import { encode } from 'blurhash';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  hasRasterSignature,
  isAnimatedRaster,
  matchesMagicBytes,
} from '@app/shared/images/raster-bytes';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
} from '@app/shared/validation/constants';

import { errorTypeOf, logSanitized } from '@/utils/log';

import { FILE_TYPE_TABLE } from '../allowlist';
import { sanitizeFilename } from '../filename';
import { uploadMsg } from '../messages';
import { optimizeImage } from './optimize';
import { imageToRgba } from './rgba';
import { sanitizeSvgServer, svgOptimizerServer } from './svg';

/**
 * `tests/unit/upload-validation.test.ts` walks this to prove every entry has a
 * magic-byte check or is the SVG exemption.
 */
export const ALLOWED_IMAGE_TYPES: readonly string[] = FILE_TYPE_TABLE.entries()
  .filter(([, spec]) => spec.kind === 'image')
  .map(([mimeType]) => mimeType)
  .toArray();

export function isAllowedImageType(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(mimeType);
}

/**
 * ⚠️ Fails open for a type with no signature entry; see `ALLOWED_IMAGE_TYPES`.
 * SVG's check is `sanitizeSvgServer`.
 */
export function validateMagicBytes(
  buffer: Buffer,
  mimeType: string
): { valid: boolean; animated?: boolean } {
  if (mimeType === 'image/svg+xml') return { valid: true };

  if (!hasRasterSignature(mimeType)) return { valid: true };
  if (!matchesMagicBytes(buffer, mimeType)) return { valid: false };
  if (isAnimatedRaster(buffer, mimeType))
    return { valid: false, animated: true };

  return { valid: true };
}

/**
 * `blurhash.encode` ignores alpha, so transparency is composited onto this
 * first; otherwise the placeholder shows whatever the decoder left underneath.
 */
const BLURHASH_BACKGROUND = 0xff;

/**
 * Never fails the upload: the placeholder is nullable, and unreadable encoder
 * output is our defect. `tests/unit/upload-validation.test.ts` pins the PNG
 * shape `imageToRgba` reads, so an encoder change cannot silently drop every
 * placeholder.
 */
async function generateBlurhash(
  imageBuffer: Buffer
): Promise<string | undefined> {
  try {
    return await encodeBlurhash(imageBuffer);
  } catch (error) {
    logSanitized('error', {
      msg: 'image.blurhash skipped',
      effect: 'the file is stored without a placeholder',
      errorClass: errorTypeOf(error),
    });
    return undefined;
  }
}

async function encodeBlurhash(imageBuffer: Buffer): Promise<string> {
  const { width, height, rgba } = await imageToRgba(imageBuffer, 32);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0xff;
    if (alpha === 0xff) continue;
    for (let channel = 0; channel < 3; channel++) {
      const value = rgba[i + channel] ?? 0;
      rgba[i + channel] =
        (value * alpha + BLURHASH_BACKGROUND * (0xff - alpha)) / 0xff;
    }
    rgba[i + 3] = 0xff;
  }
  return encode(new Uint8ClampedArray(rgba), width, height, 4, 3);
}

interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  blurhash?: string;
  originalMimeType?: string;
  originalSize?: number;
}

export interface ValidatedSvgUpload {
  cleanedSvg: string;
  embeddedRasterMegapixels: number;
}

interface UploadImageInput {
  file: File;
  buffer: Buffer;
  /** Normalized by `admitUpload`; `file.type` still carries client parameters. */
  mimeType: string;
  validatedSvg?: ValidatedSvgUpload;
}

export function validateSvgUpload(
  buffer: Buffer,
  fileName: string
): ValidatedSvgUpload {
  const result = sanitizeSvgServer(buffer.toString('utf8'));
  if (result.isValid)
    return {
      cleanedSvg: result.cleanedSvg,
      embeddedRasterMegapixels: result.embeddedRasterMegapixels,
    };

  logSanitized('warn', {
    msg: 'image.svg refused',
    reason: result.reason,
    errors: result.errors,
  });
  throw new CustomError(
    result.reason === 'animated'
      ? uploadMsg.animatedNotAllowed(sanitizeFilename(fileName))
      : result.reason === 'too-many-pixels'
        ? uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000))
        : result.reason === 'edge-too-long'
          ? uploadMsg.edgeTooLong(MAX_IMAGE_EDGE)
          : result.reason === 'invalid-inline-raster'
            ? uploadMsg.invalidInlineRaster
            : uploadMsg.invalidSvg,
    result.reason === 'too-many-pixels' || result.reason === 'edge-too-long'
      ? HTTP_STATUS.UNPROCESSABLE
      : HTTP_STATUS.BAD_REQUEST
  );
}

/** Writes neither an object nor a row; `lib/media/upload.ts` stores the result. */
export async function processImage(
  input: UploadImageInput
): Promise<ProcessedImage> {
  const { file, mimeType } = input;
  if (!isAllowedImageType(mimeType)) {
    throw new CustomError(
      uploadMsg.invalidMimeType(mimeType),
      HTTP_STATUS.BAD_REQUEST
    );
  }

  let buffer = input.buffer;
  let finalMimeType: string = mimeType;
  let finalSize = file.size;
  let width: number | undefined;
  let height: number | undefined;
  let blurhash: string | undefined;
  let finalExtension: string;

  if (mimeType === 'image/svg+xml') {
    const sanitizeResult =
      input.validatedSvg ?? validateSvgUpload(buffer, file.name);

    const optimizedSvg = svgOptimizerServer({
      data: sanitizeResult.cleanedSvg,
    });
    buffer = Buffer.from(optimizedSvg, 'utf8');
    finalSize = buffer.length;
    finalExtension = 'svg';
    // No blurhash for SVG: `Bun.Image` cannot rasterise it, and consumers
    // already tolerate a null `files.blurhash`.
  } else {
    const optimized = await optimizeImage(buffer);

    buffer = optimized.buffer;
    finalMimeType = 'image/webp';
    finalSize = optimized.size;
    width = optimized.width;
    height = optimized.height;
    blurhash = await generateBlurhash(buffer);
    finalExtension = 'webp';
  }

  return {
    buffer,
    mimeType: finalMimeType,
    extension: finalExtension,
    sizeBytes: finalSize,
    width,
    height,
    blurhash,
    ...(finalMimeType === 'image/webp' && {
      originalMimeType: mimeType,
      originalSize: file.size,
    }),
  };
}
