import { matchesAt } from '@app/shared/images/raster-bytes';

/*
 * Real, decodable images drawn by this browser's canvas: what a user picks.
 * The hand-built headers in `fixtures.ts` cover what no encoder writes.
 */

interface SampleOptions {
  /** Per-pixel noise, so the file is as hard to compress as a photo. */
  noise?: boolean;
}

const NOISE_AMPLITUDE = 48;
const JPEG_QUALITY = 0.92;

function draw(width: number, height: number, { noise = false }: SampleOptions) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#02caaf');
  gradient.addColorStop(1, '#3b2f8f');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.arc(
    width / 2,
    height / 2,
    Math.min(width, height) / 4,
    0,
    Math.PI * 2
  );
  context.fill();

  if (noise) {
    const image = context.getImageData(0, 0, width, height);
    for (let i = 0; i < image.data.length; i += 4) {
      const shift = (Math.random() - 0.5) * NOISE_AMPLITUDE;
      image.data[i] = (image.data[i] ?? 0) + shift;
      image.data[i + 1] = (image.data[i + 1] ?? 0) + shift;
      image.data[i + 2] = (image.data[i + 2] ?? 0) + shift;
    }
    context.putImageData(image, 0, 0);
  }
  return canvas;
}

/** `type` as asked when the browser encodes it, else whatever it fell back to. */
export async function sampleImage(
  name: string,
  { width, height, type }: { width: number; height: number; type: string },
  options: SampleOptions = {}
): Promise<File> {
  const canvas = draw(width, height, options);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, JPEG_QUALITY)
  );
  if (!blob) throw new Error(`the canvas encoded no ${type}`);
  return new File([blob], name, { type: blob.type });
}

export const sampleFile = (name: string, content: BlobPart, type = '') =>
  new File([content], name, { type });

/** A file of `size` bytes, for limits that read only the size. */
export const sizedFile = (name: string, size: number, type = '') =>
  sampleFile(name, new Uint8Array(size), type);

/** Width and height as this browser decodes `file`, or `null` when it cannot. */
export async function decodedSize(file: Blob) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** One pixel of `file` as this browser decodes it. */
export async function pixelAt(file: Blob, x: number, y: number) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(x, y, 1, 1).data;
  return { r, g, b, a };
}

export async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

/**
 * `image` drawn at `width` × `height` over white, so a transparent pixel
 * compares by what it shows rather than by the colour hidden under alpha 0.
 */
export async function drawnPixels(image: Blob, width: number, height: number) {
  const bitmap = await createImageBitmap(image);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height).data;
}

function squaredAndAbsolute(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let absolute = 0;
  let squared = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let channel = 0; channel < 3; channel++) {
      const diff = (a[i + channel] ?? 0) - (b[i + channel] ?? 0);
      absolute += Math.abs(diff);
      squared += diff * diff;
      count += 1;
    }
  return { absolute: absolute / count, squared: squared / count };
}

/** Mean absolute difference per colour channel, 0 (same) to 255. */
export const meanDifference = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
  squaredAndAbsolute(a, b).absolute;

/** Peak signal-to-noise ratio in dB: above 30 reads as the same picture. */
export function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  const { squared } = squaredAndAbsolute(a, b);
  return squared === 0 ? Infinity : 10 * Math.log10((255 * 255) / squared);
}

const TICK_MS = 10;

/**
 * `run`'s result, how long it took, and the longest the main thread went
 * without a timer tick.
 */
export async function withStallMeter<T>(run: () => Promise<T>) {
  const started = performance.now();
  let last = started;
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, TICK_MS);
  try {
    const result = await run();
    return {
      result,
      elapsedMs: performance.now() - started,
      longestStallMs: Math.round(longest),
    };
  } finally {
    clearInterval(timer);
  }
}

/** Whether `text` appears as ASCII anywhere in `bytes`. */
export function containsAscii(bytes: Uint8Array, text: string) {
  const needle = [...text].map((c) => c.codePointAt(0) ?? 0);
  for (let offset = 0; offset + needle.length <= bytes.length; offset++)
    if (matchesAt(bytes, offset, needle)) return true;
  return false;
}

/** Largest first: the first that fits under the input limit is kept. */
const PHOTO_SIZES = [
  [2400, 1600],
  [2000, 1333],
  [1600, 1067],
  [1280, 853],
  [1024, 683],
] as const;

/**
 * A noisy PNG of `[minBytes, maxBytes]`: as hard to compress as a photo, over
 * the server's ceiling and under the input limit, so it is admitted and must be
 * compressed. Noise makes the byte size vary by browser, hence the search.
 */
export async function photoLikePng(
  name: string,
  minBytes: number,
  maxBytes: number
) {
  for (const [width, height] of PHOTO_SIZES) {
    const file = await sampleImage(
      name,
      { width, height, type: 'image/png' },
      { noise: true }
    );
    if (file.size > maxBytes) continue;
    if (file.size >= minBytes) return file;
    break;
  }
  throw new Error(`no noisy PNG between ${minBytes} and ${maxBytes} bytes`);
}
