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

import { sanitizeForLog } from '@/utils/log';

import { FILE_TYPE_TABLE } from '../allowlist';
import { sanitizeFilename } from '../filename';
import { uploadMsg } from '../messages';
import { boundedImage } from './bounded';
import { optimizeImage, shouldOptimizeImage } from './optimize';
import { imageToRgba } from './rgba';
import { sanitizeSvgServer, svgOptimizerServer } from './svg';

/**
 * The image types this pipeline processes: the image entries of the type table,
 * in table order. `tests/unit/upload-validation.test.ts` walks it to prove every
 * one has a magic-byte check or is the SVG exemption.
 */
export const ALLOWED_IMAGE_TYPES: readonly string[] = FILE_TYPE_TABLE.entries()
  .filter(([, spec]) => spec.kind === 'image')
  .map(([mimeType]) => mimeType)
  .toArray();

export function isAllowedImageType(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(mimeType);
}

/**
 * Validates file content matches its declared MIME type using magic bytes.
 * SVG is text-based and fully validated by `sanitizeSvgServer`.
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
 * Transparent pixels are composited onto this (white) before the blurhash is
 * computed: `blurhash.encode` ignores alpha, so without it the placeholder
 * depends on whatever colour the decoder leaves under a transparent pixel. With
 * it, the placeholder is what the image looks like on a light page.
 */
const BLURHASH_BACKGROUND = 0xff;

/**
 * `undefined` rather than a throw when the pixels cannot be read: a blurhash is
 * a placeholder, `files.blurhash` is nullable, and an unreadable encoder output
 * is a defect on THIS side, not a reason to fail the upload.
 * `tests/unit/upload-validation.test.ts` pins the PNG shape `imageToRgba` reads,
 * so an encoder change fails there instead of silently dropping every
 * placeholder.
 */
async function generateBlurhash(
  imageBuffer: Buffer
): Promise<string | undefined> {
  try {
    return await encodeBlurhash(imageBuffer);
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'image.blurhash skipped',
        effect: 'the file is stored without a placeholder',
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
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

/** An image after validation, optimisation and sanitisation, ready to store. */
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

  console.error('SVG sanitization failed:', sanitizeForLog(result.errors));
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

/**
 * Validate, optimise, sanitise and fingerprint one image. Writes neither an
 * object nor a row; `lib/media/upload.ts` stores what this returns.
 */
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
  } else if (shouldOptimizeImage(mimeType)) {
    const optimized = await optimizeImage(buffer);

    buffer = optimized.buffer;
    finalMimeType = 'image/webp';
    finalSize = optimized.size;
    width = optimized.width;
    height = optimized.height;
    blurhash = await generateBlurhash(buffer);
    finalExtension = 'webp';
  } else {
    // Unreachable while `shouldOptimizeImage` holds for every raster type in
    // `ALLOWED_IMAGE_TYPES`; kept for the type that would change that.
    blurhash = await generateBlurhash(buffer);
    const metadata = await boundedImage(buffer).metadata();
    width = metadata.width;
    height = metadata.height;
    // The stored extension comes from the resolved type, never from
    // `file.name`: every other component of an object key is a row id.
    finalExtension = FILE_TYPE_TABLE.get(finalMimeType)?.extension ?? 'webp';
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
