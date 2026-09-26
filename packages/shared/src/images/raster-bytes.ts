/**
 * Byte-level facts about the raster formats this application admits.
 *
 * A leaf module because two boundaries must answer the same questions of the
 * same bytes: the back-end's upload pipeline checks an uploaded file, and
 * `images/svg-optimizer.ts` checks a raster inlined into an SVG as a `data:`
 * URI. A check living in only one of them admits through the other.
 *
 * `Uint8Array` rather than `Buffer`: the sanitizer half runs with no Node
 * globals.
 */

/** The raster types this application stores, and the bytes that identify them. */
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
function rasterTypeOf(bytes: Uint8Array): RasterMimeType | null {
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

/** Do these bytes carry the signature `mimeType` declares? */
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
 * The pixel dimensions these bytes declare, or `null` when they cannot be read.
 *
 * Read from the header rather than by decoding: the point is to refuse a
 * decompression bomb BEFORE anything allocates its raster, and a 25 MP image is
 * ~100 MB of RGBA whoever decodes it. `null` means "not stated in a form this
 * knows", which every caller must treat as unusable rather than as unlimited.
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
 * WebP states its size three different ways, one per coding.
 *
 * `VP8 ` (lossy) carries 14-bit dimensions after a three-byte start code;
 * `VP8L` (lossless) packs `width-1` and `height-1` into 28 bits; `VP8X`
 * (extended) states a 24-bit canvas size minus one. A file whose first chunk is
 * none of the three is unreadable here, which is `null`.
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

/** One container chunk: its type, and where its payload starts and ends. */
interface RasterChunk {
  type: string;
  start: number;
  length: number;
}

/**
 * `RIFF<size>WEBP` then 8-byte-headed chunks, each padded to an even length.
 *
 * A zero-length chunk is LEGAL — an empty `XMP ` is the ordinary case — so the
 * walk advances past its header rather than stopping, or a valid animated WebP
 * passes the animation check.
 */
function* webpChunks(bytes: Uint8Array): Generator<RasterChunk> {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset + 4, true);
    if (length === null) return;
    yield { type: fourCC(bytes, offset), start: offset + 8, length };
    offset += 8 + length + (length % 2);
  }
}

/**
 * An 8-byte signature, then `<4-byte big-endian length><4-byte type><data><CRC>`.
 */
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
 * The flag lives in bit 1 of the first byte of the `VP8X` chunk, which a simple
 * (non-extended) WebP does not have at all — hence the chunk walk rather than a
 * fixed offset. `Bun.Image` cannot decode animated WebP, so this refusal is also
 * what keeps it from failing deep in the encoder.
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

/**
 * A PNG carrying an `acTL` chunk before the first `IDAT`: the APNG animation
 * control.
 *
 * Position matters — a decoder ignores `acTL` that appears after `IDAT`, so an
 * `acTL` there does not make the file animated.
 */
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
 * The ICC profile these bytes carry, unexpanded.
 *
 * `Bun.Image` COPIES this profile into its output, and it is the only metadata
 * that crosses the re-encode (`eXIf`, `zTXt`, `iTXt` and `XMP ` do not), so the
 * back-end's bound on it (`lib/media/image/optimize.ts`) is a complete policy
 * only while both hold — `tests/unit/upload-validation.test.ts` asserts them.
 *
 * Deliberately does NOT expand a deflated profile: the bound that decides
 * whether expanding is safe belongs to the caller that can afford `node:zlib`.
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
 * Animated uploads are refused, declared ONCE for every admitted raster format:
 * an APNG is named `.png` and declared `image/png`, so a per-format check that
 * misses it flattens it to its first frame without a word.
 *
 * SVG is absent because it carries no magic bytes — `sanitizeSvg` refuses
 * `ANIMATION_ELEMENTS` and `processImage` maps that to the same message.
 */
const ANIMATION_CHECKS = new Map<string, (bytes: Uint8Array) => boolean>([
  ['image/png', isAnimatedPng],
  ['image/webp', isAnimatedWebp],
]);

export function isAnimatedRaster(bytes: Uint8Array, mimeType: string): boolean {
  return ANIMATION_CHECKS.get(mimeType)?.(bytes) ?? false;
}
