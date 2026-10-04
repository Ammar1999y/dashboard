import {
  dataViewOf,
  isAnimatedRaster,
  matchesAt,
  rasterDimensions,
  rasterTypeOf,
} from '@app/shared/images/raster-bytes';

/*
 * The header of every image `prepareFile` decodes, read before the canvas
 * allocates its raster. PNG and WebP come from `@app/shared/images/raster-bytes`,
 * which the server runs too. JPEG and HEIF are read here only: the server
 * stores neither, so it has no reader for them.
 */

export interface ImageHeader {
  animated: boolean;
  /** `null` is unreadable: unusable, never unlimited. */
  size: { width: number; height: number } | null;
}

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/** Frame headers: every `SOFn` but DHT (`C4`), JPG (`C8`) and DAC (`CC`). */
const JPEG_FRAME_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Markers with no length field: TEM, RST0–7, SOI. */
const isStandaloneMarker = (marker: number) =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

const SOS = 0xda;
const EOI = 0xd9;

/** The ISO/IEC 23008-12 brands of a HEIF image or image sequence. */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  'mif1',
  'mif2',
  'msf1',
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
]);

/** A bound on the boxes walked at one level, so a crafted file cannot spin. */
const MAX_BOXES = 1024;

function readU16(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return dataViewOf(bytes).getUint16(offset, false);
}

function readU32(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return dataViewOf(bytes).getUint32(offset, false);
}

function fourCC(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let index = 0; index < 4; index++)
    out += String.fromCodePoint(bytes[offset + index] ?? 0);
  return out;
}

/**
 * Walks the segments up to the first frame header. A thumbnail's frame header
 * sits inside its APP1 segment, which is skipped whole, so it is never read.
 */
function jpegSize(bytes: Uint8Array): ImageHeader['size'] {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStandaloneMarker(marker)) {
      offset += 2;
      continue;
    }
    if (marker === SOS || marker === EOI) return null;
    const length = readU16(bytes, offset + 2);
    if (length === null || length < 2) return null;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      const height = readU16(bytes, offset + 5);
      const width = readU16(bytes, offset + 7);
      // A height of 0 is defined later by a DNL marker, after the scan.
      return width && height ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

interface Box {
  type: string;
  /** Where the payload starts, after the header. */
  start: number;
  end: number;
}

/** The boxes in `[from, to)`; stops at the first that does not fit. */
function boxesIn(bytes: Uint8Array, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (boxes.length < MAX_BOXES && offset + 8 <= to) {
    const declared = readU32(bytes, offset);
    if (declared === null) break;
    let header = 8;
    let size = declared;
    if (declared === 1) {
      const high = readU32(bytes, offset + 8);
      const low = readU32(bytes, offset + 12);
      if (high === null || low === null) break;
      header = 16;
      size = high * 2 ** 32 + low;
    } else if (declared === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) break;
    boxes.push({
      type: fourCC(bytes, offset + 4),
      start: offset + header,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
}

/** Version and flags open a full box's payload. */
const FULL_BOX_HEADER = 4;

const childBox = (bytes: Uint8Array, parent: Box, type: string, skip = 0) =>
  boxesIn(bytes, parent.start + skip, parent.end).find((b) => b.type === type);

function isHeif(bytes: Uint8Array): boolean {
  const [ftyp] = boxesIn(bytes, 0, bytes.length);
  if (ftyp?.type !== 'ftyp') return false;
  const brands = [fourCC(bytes, ftyp.start)];
  // After the major brand and the minor version, the compatible brands.
  for (let offset = ftyp.start + 8; offset + 4 <= ftyp.end; offset += 4)
    brands.push(fourCC(bytes, offset));
  return brands.some((brand) => HEIF_BRANDS.has(brand));
}

/**
 * The largest `ispe` among the item properties: the primary image's own, a
 * grid's full canvas, or a thumbnail's. Any of them is what a decoder may
 * allocate, so the largest is the one held to the limit.
 */
function heifSize(bytes: Uint8Array): ImageHeader['size'] {
  const meta = boxesIn(bytes, 0, bytes.length).find((b) => b.type === 'meta');
  if (!meta) return null;
  const iprp = childBox(bytes, meta, 'iprp', FULL_BOX_HEADER);
  const ipco = iprp && childBox(bytes, iprp, 'ipco');
  if (!ipco) return null;

  let largest: ImageHeader['size'] = null;
  for (const box of boxesIn(bytes, ipco.start, ipco.end)) {
    if (box.type !== 'ispe') continue;
    const width = readU32(bytes, box.start + FULL_BOX_HEADER);
    const height = readU32(bytes, box.start + FULL_BOX_HEADER + 4);
    if (!width || !height) return null;
    if (!largest || width * height > largest.width * largest.height)
      largest = { width, height };
  }
  return largest;
}

/**
 * A `moov` box carries a sequence track: the canvas would keep one frame, the
 * flattening the animated-raster refusal exists for.
 */
const isHeifSequence = (bytes: Uint8Array) =>
  boxesIn(bytes, 0, bytes.length).some((b) => b.type === 'moov');

/**
 * What these bytes are, by signature rather than declared type. `null` when
 * they are no image the pipeline decodes.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const raster = rasterTypeOf(bytes);
  if (raster !== null)
    return {
      animated: isAnimatedRaster(bytes, raster),
      size: rasterDimensions(bytes, raster),
    };
  if (matchesAt(bytes, 0, JPEG_SIGNATURE))
    return { animated: false, size: jpegSize(bytes) };
  if (isHeif(bytes))
    return { animated: isHeifSequence(bytes), size: heifSize(bytes) };
  return null;
}
