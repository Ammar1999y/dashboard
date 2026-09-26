/**
 * WebP re-encoding, sized down until it fits a byte target.
 *
 * `Bun.Image` cannot decode SVG or animated WebP; neither reaches this module:
 * `shouldOptimizeImage` excludes SVG, and `validateMagicBytes` refuses animated
 * WebP at the door.
 */
import { inflateSync } from 'node:zlib';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { iccProfileChunk } from '@app/shared/images/raster-bytes';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  SERVER_MAX_IMAGE_SIZE,
} from '@app/shared/validation/constants';

import { uploadMsg } from '../messages';
import { MIB } from '../units';
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
    return new CustomError(
      uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000)),
      HTTP_STATUS.UNPROCESSABLE
    );
  if (code !== null && UNDECODABLE_CODES.has(code))
    return new CustomError(uploadMsg.undecodable, HTTP_STATUS.UNPROCESSABLE);
  // The dimension guard below refuses this before the encoder is reached; this
  // is the backstop for a limit the guard does not know about, and still a
  // rejection of the input rather than a server fault.
  if (code === 'ERR_IMAGE_ENCODE_FAILED')
    return new CustomError(
      uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
      HTTP_STATUS.UNPROCESSABLE
    );

  return new CustomError(uploadMsg.uploadFailed, HTTP_STATUS.INTERNAL_ERROR);
}

/**
 * Megapixels of decode work one request costs, at least 1, from the header
 * alone. Runs BEFORE the encoder slot is taken, which also moves the
 * pixel-bomb refusal ahead of the queue.
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

/** One encode attempt; the only place the encoder options are written. */
async function encodeAttempt(input: Buffer, width: number, quality: number) {
  // This re-encode is also what STRIPS image metadata: the output is built from
  // decoded pixels and the encoder emits no `EXIF`/`XMP ` chunk. Skipping it for
  // an input already under the byte ceiling would store and serve camera EXIF,
  // location included.
  const image = boundedImage(input)
    // Height omitted keeps the aspect ratio; `withoutEnlargement` stops a small
    // image being blown up to `initialWidth`.
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
 * The ceiling a stored image cannot exceed, whatever the ladder reaches.
 *
 * `targetSize` is what the ladder AIMS at; this is what it may not pass. It
 * sits under `MAX_IMAGE_SIZE`, the ceiling on what may be uploaded, so anything
 * this pipeline stores can still be fed back through it.
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
 * Every numeric option, checked before it can drive a loop: a step of `0`,
 * negative or `NaN` never reaches the floor, and `buildLadder` would spin
 * synchronously, taking the event loop with it.
 */
function assertLadderOptions(opts: LadderOptions): void {
  for (const [name, value] of Object.entries(opts))
    if (!Number.isFinite(value) || value <= 0)
      throw new CustomError(
        `optimizeImage: ${name} must be a positive finite number`,
        HTTP_STATUS.INTERNAL_ERROR
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
    // `MAX_IMAGE_PIXELS` bounds AREA and says nothing about a single side, so an
    // image well inside it can still be one the output format cannot hold.
    if (metadata.width > MAX_IMAGE_EDGE || metadata.height > MAX_IMAGE_EDGE)
      throw new CustomError(
        uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
        HTTP_STATUS.UNPROCESSABLE
      );

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
        throw new CustomError(
          uploadMsg.targetUnreachable,
          HTTP_STATUS.UNPROCESSABLE
        );
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
      // The FLOOR before the search: when the target is unreachable every rung
      // the search would visit ends in the same answer, and this settles it in
      // two encodes. When the floor fits, the search still returns the EARLIEST
      // fitting rung.
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
      console.warn(
        JSON.stringify({
          msg: 'image.optimize target unreachable',
          finalBytes: best.size,
          targetBytes: targetSize,
          ceilingBytes: ceiling,
          accepted: best.size <= ceiling,
          iterations,
        })
      );
      if (best.size > ceiling)
        throw new CustomError(
          uploadMsg.targetUnreachable,
          HTTP_STATUS.UNPROCESSABLE
        );
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
 * The one piece of input metadata `Bun.Image` carries into its output. Above
 * every profile in ordinary circulation, far below one that is interesting to
 * an attacker.
 */
export const MAX_ICC_PROFILE_BYTES = 64 * 1024;

/**
 * Refuse an ICC profile the encoder would copy and this application would then
 * publish.
 *
 * The pipeline prices a request in PIXELS, and a profile is not pixels: a small
 * PNG carrying a deflated huge profile makes every encode attempt as large.
 * Under the bound the profile is kept, because dropping it is a visible colour
 * shift on wide-gamut images.
 *
 * ⚠️ Must run BEFORE the encoder slot is taken, or a bomb holds the queue while
 * it is priced. `maxOutputLength` is what makes the expansion refuse rather than
 * allocate.
 */
function assertIccProfileBounded(input: Buffer): void {
  const profile = iccProfileChunk(input);
  if (profile === null) return;

  const tooLarge = new CustomError(
    uploadMsg.iccProfileTooLarge(Math.floor(MAX_ICC_PROFILE_BYTES / 1024)),
    HTTP_STATUS.UNPROCESSABLE
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

export const shouldOptimizeImage = (mimeType: string) =>
  mimeType.startsWith('image/') &&
  !(mimeType === 'image/svg+xml' || mimeType === 'image/gif');
