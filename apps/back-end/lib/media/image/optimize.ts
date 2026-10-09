/**
 * `Bun.Image` cannot decode SVG or animated WebP; `processImage` routes SVG to
 * the sanitiser and `validateMagicBytes` refuses animated WebP before this.
 */
import { inflateSync } from 'node:zlib';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { iccProfileChunk } from '@app/shared/images/raster-bytes';
import { uploadMsg } from '@app/shared/messages/media';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MIB,
  SERVER_MAX_IMAGE_SIZE,
} from '@app/shared/validation/constants';

import { serverFault } from '@/lib/http/response';

import { logLine } from '@/utils/log';

import { contentRefused, imageNotCompressible, imageTooLarge } from '../errors';
import { boundedImage } from './bounded';

const UNDECODABLE_CODES = new Set([
  'ERR_IMAGE_DECODE_FAILED',
  'ERR_IMAGE_UNKNOWN_FORMAT',
  'ERR_IMAGE_FORMAT_UNSUPPORTED',
]);

/** `Bun.Image` errors carry a `code`; nothing in the type system promises it. */
function imageErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function toUploadError(error: unknown): CustomError {
  if (error instanceof CustomError) return error;

  const code = imageErrorCode(error);
  if (code === 'ERR_IMAGE_TOO_MANY_PIXELS')
    return imageTooLarge(
      uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000))
    );
  if (code !== null && UNDECODABLE_CODES.has(code))
    return contentRefused(uploadMsg.undecodable, HTTP_STATUS.UNPROCESSABLE);
  // Backstop for an encoder limit the dimension guard below does not know
  // about; still the input's fault, not the server's.
  if (code === 'ERR_IMAGE_ENCODE_FAILED')
    return imageTooLarge(uploadMsg.edgeTooLong(MAX_IMAGE_EDGE));

  return serverFault(uploadMsg.uploadFailed, error);
}

/**
 * From the header alone, and BEFORE the encoder slot is taken, so a pixel bomb
 * is refused ahead of the queue.
 */
export async function measureEncodeCost(input: Buffer): Promise<number> {
  try {
    const { width, height } = await boundedImage(input).metadata();
    return Math.max(1, Math.ceil((width * height) / 1_000_000));
  } catch (error) {
    throw toUploadError(error);
  }
}

interface OptimizeImageOptions {
  /** Bytes. */
  targetSize?: number;
  initialQuality?: number;
  /** The quality floor reached before the width starts shrinking. */
  minQuality?: number;
  initialWidth?: number;
  minWidth?: number;
  qualityStep?: number;
  widthStep?: number;
}

/** The only place the encoder options are written. */
async function encodeAttempt(input: Buffer, width: number, quality: number) {
  // This re-encode is also what STRIPS `EXIF`/`XMP `: skipping it for an input
  // already under the byte ceiling would serve camera EXIF, location included.
  const image = boundedImage(input)
    .resize(width, undefined, { withoutEnlargement: true })
    .webp({ quality });
  const buffer = await image.buffer();
  // `image.width`/`height` are -1 until a terminal resolves.
  return {
    buffer,
    size: buffer.length,
    width: image.width,
    height: image.height,
  };
}

interface OptimizeImageResult {
  buffer: Buffer;
  width: number;
  height: number;
  size: number;
  format: 'webp';
  iterations: number;
}

/** A ceiling on the ladder, so an edit to the walk itself cannot spin. */
const MAX_LADDER_RUNGS = 128;
const MAX_ENCODE_ATTEMPTS = 16;

/**
 * What the ladder may not pass (`targetSize` is only its aim). Kept under
 * `MAX_IMAGE_SIZE` so anything stored can be fed back through the pipeline.
 */
const MAX_STORED_IMAGE_BYTES = 800 * 1024;

interface Rung {
  width: number;
  quality: number;
}

interface LadderOptions {
  startWidth: number;
  initialQuality: number;
  minQuality: number;
  qualityStep: number;
  minWidth: number;
  widthStep: number;
}

/**
 * A step of `0`, negative or `NaN` never reaches the floor, and `buildLadder`
 * would spin synchronously, taking the event loop with it.
 */
function assertLadderOptions(opts: LadderOptions): void {
  for (const [name, value] of Object.entries(opts))
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(
        `optimizeImage: ${name} must be a positive finite number`
      );
}

function buildLadder(opts: LadderOptions): Rung[] {
  assertLadderOptions(opts);

  const rungs: Rung[] = [];
  let quality = opts.initialQuality;
  rungs.push({ width: opts.startWidth, quality });
  while (quality > opts.minQuality && rungs.length < MAX_LADDER_RUNGS) {
    quality = Math.max(quality - opts.qualityStep, opts.minQuality);
    rungs.push({ width: opts.startWidth, quality });
  }
  let width = opts.startWidth;
  while (width > opts.minWidth && rungs.length < MAX_LADDER_RUNGS) {
    width = Math.max(width - opts.widthStep, opts.minWidth);
    rungs.push({ width, quality: opts.minQuality });
  }
  return rungs;
}

async function optimizeImageWithinSlot(
  input: Buffer,
  options: OptimizeImageOptions = {}
): Promise<OptimizeImageResult> {
  const {
    targetSize = SERVER_MAX_IMAGE_SIZE * MIB,
    initialQuality = 95,
    minQuality = 50,
    initialWidth = 3048,
    minWidth = 800,
    qualityStep = 5,
    widthStep = 100,
  } = options;

  try {
    const metadata = await boundedImage(input).metadata();
    // `MAX_IMAGE_PIXELS` bounds area, not a side the output format cannot hold.
    if (metadata.width > MAX_IMAGE_EDGE || metadata.height > MAX_IMAGE_EDGE)
      throw imageTooLarge(uploadMsg.edgeTooLong(MAX_IMAGE_EDGE));

    const originalWidth = metadata.width || initialWidth;
    const originalHeight = metadata.height || initialWidth;
    const longestEdgeWidth = Math.max(
      1,
      Math.floor((originalWidth * initialWidth) / originalHeight)
    );
    const startWidth = Math.min(originalWidth, initialWidth, longestEdgeWidth);

    const ladder = buildLadder({
      startWidth,
      initialQuality,
      minQuality,
      qualityStep,
      minWidth: Math.min(minWidth, startWidth),
      widthStep,
    });

    let iterations = 0;
    const measure = async (index: number) => {
      if (iterations >= MAX_ENCODE_ATTEMPTS)
        throw imageNotCompressible(uploadMsg.targetUnreachable);
      iterations++;
      const rung = ladder[index];
      if (!rung) throw new Error('ladder index out of range');
      return encodeAttempt(input, rung.width, rung.quality);
    };

    let best = await measure(0);
    let fitting = best.size <= targetSize ? best : null;
    const remember = (attempt: typeof best) => {
      if (attempt.size < best.size) best = attempt;
      return attempt;
    };

    if (!fitting && ladder.length > 1) {
      // The floor first settles an unreachable target in two encodes; when it
      // fits, the search still returns the EARLIEST fitting rung.
      const floor = remember(await measure(ladder.length - 1));
      if (floor.size <= targetSize) {
        fitting = floor;
        let lo = 1;
        let hi = ladder.length - 2;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const attempt = remember(await measure(mid));
          if (attempt.size <= targetSize) {
            fitting = attempt;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
      }
    }

    if (!fitting) {
      // The target is a goal, not the contract: a dense high-detail image that
      // cannot reach it keeps the floor rung, up to a ceiling nothing may exceed.
      const ceiling = Math.max(targetSize, MAX_STORED_IMAGE_BYTES);
      logLine('warn', {
        msg: 'image.optimize target unreachable',
        finalBytes: best.size,
        targetBytes: targetSize,
        ceilingBytes: ceiling,
        accepted: best.size <= ceiling,
        iterations,
      });
      if (best.size > ceiling)
        throw imageNotCompressible(uploadMsg.targetUnreachable);
      fitting = best;
    }

    const chosen = fitting;
    return {
      buffer: chosen.buffer,
      width: chosen.width,
      height: chosen.height,
      size: chosen.size,
      format: 'webp',
      iterations,
    };
  } catch (error) {
    if (error instanceof CustomError) throw error;
    throw toUploadError(error);
  }
}

const IMAGE_ENCODER_QUEUE_LIMIT = 4;
const encoderAdmission = {
  active: false,
  waiters: [] as Array<() => void>,
};

async function acquireEncoder(): Promise<() => void> {
  if (encoderAdmission.active) {
    if (encoderAdmission.waiters.length >= IMAGE_ENCODER_QUEUE_LIMIT)
      throw new CustomError(
        uploadMsg.processingBusy,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );
    await new Promise<void>((resolve) => {
      encoderAdmission.waiters.push(resolve);
    });
  }
  encoderAdmission.active = true;
  return () => {
    const next = encoderAdmission.waiters.shift();
    if (next) next();
    else encoderAdmission.active = false;
  };
}

/**
 * The one input metadata `Bun.Image` carries into its output. Above ordinary
 * profiles, far below a hostile one.
 */
export const MAX_ICC_PROFILE_BYTES = 64 * 1024;

/**
 * Requests are priced in pixels, yet a small PNG with a huge deflated profile
 * makes every encode that large. Under the bound it is kept: dropping it
 * visibly shifts wide-gamut colour.
 *
 * ⚠️ Must run BEFORE the encoder slot is taken, or a bomb holds the queue while
 * it is priced; `maxOutputLength` makes the expansion refuse, not allocate.
 */
function assertIccProfileBounded(input: Buffer): void {
  const profile = iccProfileChunk(input);
  if (profile === null) return;

  const tooLarge = imageTooLarge(
    uploadMsg.iccProfileTooLarge(Math.floor(MAX_ICC_PROFILE_BYTES / 1024))
  );

  if (!profile.deflated) {
    if (profile.data.byteLength > MAX_ICC_PROFILE_BYTES) throw tooLarge;
    return;
  }
  try {
    inflateSync(profile.data, { maxOutputLength: MAX_ICC_PROFILE_BYTES });
  } catch {
    // Over the bound, or not deflate at all: either way not carried.
    throw tooLarge;
  }
}

export async function optimizeImage(
  input: Buffer,
  options: OptimizeImageOptions = {}
): Promise<OptimizeImageResult> {
  assertIccProfileBounded(input);
  const release = await acquireEncoder();
  try {
    return await optimizeImageWithinSlot(input, options);
  } finally {
    release();
  }
}
