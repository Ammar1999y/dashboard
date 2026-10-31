/**
 * Shared by the upload pipeline and `images/svg-sanitizer.ts` (rasters inlined
 * as `data:` URIs): a check living in only one of them admits through the
 * other. `Uint8Array`, not `Buffer`: the sanitizer runs with no Node globals.
 */

const RASTER_MAGIC_BYTES = {
  'image/png': {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
  },
  'image/webp': {
    bytes: [0x52, 0x49, 0x46, 0x46],
    offset: 0,
    secondary: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  },
} as const;

type RasterMimeType = keyof typeof RASTER_MAGIC_BYTES;

export function hasRasterSignature(
  mimeType: string
): mimeType is RasterMimeType {
  return Object.hasOwn(RASTER_MAGIC_BYTES, mimeType);
}

/** Which admitted raster these bytes actually are, from the signature alone. */
export function rasterTypeOf(bytes: Uint8Array): RasterMimeType | null {
  for (const mimeType of Object.keys(RASTER_MAGIC_BYTES))
    if (hasRasterSignature(mimeType) && matchesMagicBytes(bytes, mimeType))
      return mimeType;
  return null;
}

export function matchesAt(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[]
): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/** A `DataView` over exactly these bytes, not over the whole backing buffer. */
export function dataViewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function matchesMagicBytes(
  bytes: Uint8Array,
  mimeType: string
): boolean {
  if (!hasRasterSignature(mimeType)) return false;
  const signature = RASTER_MAGIC_BYTES[mimeType];
  if (!matchesAt(bytes, signature.offset, signature.bytes)) return false;

  const secondary = 'secondary' in signature ? signature.secondary : undefined;
  return !secondary || matchesAt(bytes, secondary.offset, secondary.bytes);
}

function readU32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean
): number | null {
  if (offset + 4 > bytes.length) return null;
  return dataViewOf(bytes).getUint32(offset, littleEndian);
}

function fourCC(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let index = 0; index < 4; index++)
    out += String.fromCodePoint(bytes[offset + index] ?? 0);
  return out;
}

/**
 * From the header, so a decompression bomb is refused BEFORE anything allocates
 * its raster. ⚠️ `null` is unreadable: unusable, never unlimited.
 */
export function rasterDimensions(
  bytes: Uint8Array,
  mimeType: string
): { width: number; height: number } | null {
  if (!matchesMagicBytes(bytes, mimeType)) return null;
  return mimeType === 'image/png'
    ? pngDimensions(bytes)
    : webpDimensions(bytes);
}

/** `IHDR` is required to be the first chunk, so its payload is at a fixed offset. */
function pngDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (fourCC(bytes, 12) !== 'IHDR') return null;
  const width = readU32(bytes, 16, false);
  const height = readU32(bytes, 20, false);
  return width && height ? { width, height } : null;
}

/**
 * `VP8 ` has 14-bit sizes after a start code, `VP8L` packs `width-1`/`height-1`
 * into 28 bits, `VP8X` states a 24-bit canvas size minus one.
 */
function webpDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  const chunk = fourCC(bytes, 12);

  if (chunk === 'VP8 ') {
    if (!matchesAt(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    // Frame tag (3) + start code (3) precede the two 14-bit dimensions.
    const width = readU16(bytes, 26);
    const height = readU16(bytes, 28);
    if (width === null || height === null) return null;
    const decodedWidth = width & 0x3f_ff;
    const decodedHeight = height & 0x3f_ff;
    return decodedWidth && decodedHeight
      ? { width: decodedWidth, height: decodedHeight }
      : null;
  }

  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const packed = readU32(bytes, 21, true);
    if (packed === null) return null;
    return {
      width: (packed & 0x3f_ff) + 1,
      height: ((packed >> 14) & 0x3f_ff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    const width = readU24(bytes, 24);
    const height = readU24(bytes, 27);
    return width === null || height === null
      ? null
      : { width: width + 1, height: height + 1 };
  }

  return null;
}

/** Little-endian 16-bit, for the two `VP8 ` dimensions. */
function readU16(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** Little-endian 24-bit, which only the `VP8X` canvas size uses. */
function readU24(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null;
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

interface RasterChunk {
  type: string;
  start: number;
  length: number;
}

/**
 * ⚠️ A zero-length chunk is LEGAL (an empty `XMP `): stopping at one would let
 * an animated WebP pass the animation check.
 */
function* webpChunks(
  bytes: Uint8Array,
  end = bytes.length
): Generator<RasterChunk> {
  let offset = 12;
  while (offset + 8 <= end) {
    const length = readU32(bytes, offset + 4, true);
    if (length === null) return;
    yield { type: fourCC(bytes, offset), start: offset + 8, length };
    offset += 8 + length + (length % 2);
  }
}

/** An 8-byte signature, then `<4-byte big-endian length><4-byte type><data><CRC>`. */
function* pngChunks(bytes: Uint8Array): Generator<RasterChunk> {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset, false);
    if (length === null) return;
    yield { type: fourCC(bytes, offset + 4), start: offset + 8, length };
    offset += 12 + length;
  }
}

const WEBP_ANIMATION_FLAG = 0x02;

/**
 * A chunk walk, since a simple WebP has no `VP8X` at all. `Bun.Image` cannot
 * decode animated WebP, so this also keeps it from failing deep in the encoder.
 */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  for (const chunk of webpChunks(bytes)) {
    if (chunk.type === 'VP8X')
      return ((bytes[chunk.start] ?? 0) & WEBP_ANIMATION_FLAG) !== 0;
    // An `ANIM` chunk without a VP8X flag is malformed, but treat it as animated
    // rather than reasoning about which of two contradictory headers wins.
    if (chunk.type === 'ANIM' || chunk.type === 'ANMF') return true;
  }
  return false;
}

export function isLossyWebp(bytes: Uint8Array): boolean {
  if (rasterTypeOf(bytes) !== 'image/webp') return false;
  for (const chunk of webpChunks(bytes)) if (chunk.type === 'VP8 ') return true;
  return false;
}

/** A decoder ignores an `acTL` after the first `IDAT`. */
function isAnimatedPng(bytes: Uint8Array): boolean {
  for (const chunk of pngChunks(bytes)) {
    if (chunk.type === 'acTL') return true;
    if (chunk.type === 'IDAT' || chunk.type === 'IEND') return false;
  }
  return false;
}

/** An embedded ICC profile, still in whatever encoding its container uses. */
export interface EmbeddedIccProfile {
  /** PNG stores the profile zlib-deflated; WebP stores it verbatim. */
  deflated: boolean;
  data: Uint8Array;
}

/**
 * `Bun.Image` copies this profile, and no other metadata, into its output, so
 * the bound in `lib/media/image/icc.ts` is complete only while both hold
 * (`tests/unit/upload-validation.test.ts` asserts them). Left unexpanded: that
 * bound belongs to the caller that has `node:zlib`.
 */
export function iccProfileChunk(bytes: Uint8Array): EmbeddedIccProfile | null {
  const mimeType = rasterTypeOf(bytes);
  if (mimeType === 'image/webp') {
    for (const chunk of webpChunks(bytes))
      if (chunk.type === 'ICCP')
        return {
          deflated: false,
          data: bytes.subarray(chunk.start, chunk.start + chunk.length),
        };
    return null;
  }
  if (mimeType !== 'image/png') return null;

  for (const chunk of pngChunks(bytes)) {
    if (chunk.type === 'IDAT' || chunk.type === 'IEND') return null;
    if (chunk.type !== 'iCCP') continue;
    const end = chunk.start + chunk.length;
    // `<profile name (1-79 bytes)>\0<compression method><deflated profile>`.
    const separator = bytes.indexOf(0, chunk.start);
    if (separator === -1 || separator + 2 > end) return null;
    return { deflated: true, data: bytes.subarray(separator + 2, end) };
  }
  return null;
}

/**
 * ONCE for every admitted raster: an APNG is declared `image/png`, so a check
 * that misses it flattens it to its first frame silently. SVG's check is
 * `ANIMATION_ELEMENTS` in `sanitizeSvg`.
 */
const ANIMATION_CHECKS = new Map<string, (bytes: Uint8Array) => boolean>([
  ['image/png', isAnimatedPng],
  ['image/webp', isAnimatedWebp],
]);

export function isAnimatedRaster(bytes: Uint8Array, mimeType: string): boolean {
  return ANIMATION_CHECKS.get(mimeType)?.(bytes) ?? false;
}

/**
 * What a decoder draws with. `iCCP` stays, as the direct path keeps the
 * profile: dropping it shifts colour. APNG chunks go: an animated PNG is
 * refused before this, and without a leading `acTL` a decoder ignores them.
 */
const PNG_RENDERING_CHUNKS: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'pHYs',
  'cICP',
  'mDCV',
  'cLLI',
]);

const PNG_CHUNK_TYPE = /^[A-Za-z]{4}$/;

/** A decoder must refuse a critical chunk it does not know. */
const CRITICAL_PNG_CHUNK = /^[A-Z]/;

const WEBP_IMAGE_CHUNKS: ReadonlySet<string> = new Set(['VP8 ', 'VP8L']);
const WEBP_RENDERING_CHUNKS: ReadonlySet<string> = new Set([
  'ICCP',
  'ALPH',
  ...WEBP_IMAGE_CHUNKS,
]);

const VP8X_PAYLOAD_LENGTH = 10;
const WEBP_EXIF_FLAG = 0x08;
const WEBP_XMP_FLAG = 0x04;

const EXIF_ORIENTATION_TAG = 0x01_12;
const TIFF_SHORT = 3;

/** `Exif\0\0`, which some WebP writers put before the TIFF header. */
const EXIF_PREAMBLE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/**
 * The one EXIF field a browser draws with. What it cannot read counts as 1,
 * as a decoder treats it, so an unreadable block is dropped, not refused.
 */
function exifOrientation(payload: Uint8Array): number {
  const tiff = matchesAt(payload, 0, EXIF_PREAMBLE)
    ? payload.subarray(EXIF_PREAMBLE.length)
    : payload;
  const littleEndian = matchesAt(tiff, 0, [0x49, 0x49, 0x2a, 0x00]);
  if (!littleEndian && !matchesAt(tiff, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 1;

  const view = dataViewOf(tiff);
  const ifd = readU32(tiff, 4, littleEndian) ?? tiff.length;
  if (ifd + 2 > tiff.length) return 1;
  const entriesEnd = ifd + 2 + view.getUint16(ifd, littleEndian) * 12;
  for (
    let entry = ifd + 2;
    entry < entriesEnd && entry + 12 <= tiff.length;
    entry += 12
  ) {
    if (view.getUint16(entry, littleEndian) !== EXIF_ORIENTATION_TAG) continue;
    const value = view.getUint16(entry + 8, littleEndian);
    return view.getUint16(entry + 2, littleEndian) === TIFF_SHORT &&
      value >= 1 &&
      value <= 8
      ? value
      : 1;
  }
  return 1;
}

/** A big-endian TIFF whose IFD0 holds `Orientation` alone. */
function orientationExif(orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  const view = dataViewOf(tiff);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a]);
  view.setUint32(4, 8);
  view.setUint16(8, 1);
  view.setUint16(10, EXIF_ORIENTATION_TAG);
  view.setUint16(12, TIFF_SHORT);
  view.setUint32(14, 1);
  view.setUint16(18, orientation);
  return tiff;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  return crc;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

const asciiBytes = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.codePointAt(0) ?? 0);

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = dataViewOf(chunk);
  view.setUint32(0, data.length);
  chunk.set(asciiBytes(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Padded to an even length, which the size field leaves out. */
function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + data.length + (data.length % 2));
  chunk.set(asciiBytes(type));
  dataViewOf(chunk).setUint32(4, data.length, true);
  chunk.set(data, 8);
  return chunk;
}

/** Kept chunks are copied whole, CRC included, so none is re-encoded. */
function pngWithoutMetadata(bytes: Uint8Array): Uint8Array | null {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let exifSeen = false;
  for (const chunk of pngChunks(bytes)) {
    const end = chunk.start + chunk.length + 4;
    // `IHDR` first, and only there.
    if (
      end > bytes.length ||
      !PNG_CHUNK_TYPE.test(chunk.type) ||
      (kept.length === 1) !== (chunk.type === 'IHDR')
    )
      return null;

    if (!exifSeen && chunk.type === 'eXIf') {
      // A decoder reads only the first; a later one is dropped below.
      exifSeen = true;
      const orientation = exifOrientation(
        bytes.subarray(chunk.start, chunk.start + chunk.length)
      );
      if (orientation !== 1)
        kept.push(pngChunk('eXIf', orientationExif(orientation)));
    } else if (PNG_RENDERING_CHUNKS.has(chunk.type))
      kept.push(bytes.subarray(chunk.start - 8, end));
    else if (CRITICAL_PNG_CHUNK.test(chunk.type)) return null;

    if (chunk.type === 'IEND') return concatBytes(kept);
  }
  return null;
}

/**
 * Within the RIFF size: past it is not part of the file. A simple WebP (no
 * `VP8X`) is its image chunk alone, and cannot carry EXIF.
 */
function webpWithoutMetadata(bytes: Uint8Array): Uint8Array | null {
  const riffSize = readU32(bytes, 4, true);
  if (riffSize === null || riffSize < 4 || 8 + riffSize > bytes.length)
    return null;
  const end = 8 + riffSize;

  const kept: Uint8Array[] = [];
  let header: Uint8Array | null = null;
  let images = 0;
  let exifSeen = false;
  let exifKept = false;
  for (const chunk of webpChunks(bytes, end)) {
    if (chunk.start + chunk.length > end) return null;
    const data = bytes.subarray(chunk.start, chunk.start + chunk.length);

    if (kept.length === 0 && chunk.type === 'VP8X') {
      if (chunk.length < VP8X_PAYLOAD_LENGTH) return null;
      header = riffChunk(chunk.type, data);
      kept.push(header);
    } else if (kept.length === 0 && !WEBP_IMAGE_CHUNKS.has(chunk.type))
      return null;
    else if (!exifSeen && chunk.type === 'EXIF') {
      // A decoder reads only the first; a later one is dropped below.
      exifSeen = true;
      const orientation = exifOrientation(data);
      exifKept = orientation !== 1;
      if (exifKept) kept.push(riffChunk('EXIF', orientationExif(orientation)));
    } else if (WEBP_RENDERING_CHUNKS.has(chunk.type)) {
      kept.push(riffChunk(chunk.type, data));
      if (WEBP_IMAGE_CHUNKS.has(chunk.type)) images++;
      if (!header) break;
    }
  }
  if (images !== 1) return null;

  // The flags byte is the first of the VP8X payload.
  if (header)
    header[8] =
      ((header[8] ?? 0) & ~(WEBP_EXIF_FLAG | WEBP_XMP_FLAG)) |
      (exifKept ? WEBP_EXIF_FLAG : 0);
  const body = concatBytes(kept);
  const out = new Uint8Array(12 + body.length);
  out.set(asciiBytes('RIFF'));
  dataViewOf(out).setUint32(4, 4 + body.length, true);
  out.set(asciiBytes('WEBP'), 8);
  out.set(body, 12);
  return out;
}

/**
 * The image rebuilt from what renders: EXIF (location included), XMP and text
 * are dropped, and an EXIF orientation is kept alone. `null` is a container
 * that does not parse, never the input passed through.
 */
export function rasterWithoutMetadata(
  bytes: Uint8Array,
  mimeType: string
): Uint8Array | null {
  if (!matchesMagicBytes(bytes, mimeType)) return null;
  return mimeType === 'image/png'
    ? pngWithoutMetadata(bytes)
    : webpWithoutMetadata(bytes);
}
