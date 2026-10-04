/*
 * Image headers built byte by byte: the shapes no encoder writes on request
 * (animation, a pixel bomb, a broken header). Only the header is real, so a
 * decoder refuses them; they test what `prepareFile` decides before decoding.
 * `tests/prepare-file.test.ts` runs the same bytes outside the browser.
 */

const ascii = (text: string) => [...text].map((c) => c.codePointAt(0) ?? 0);
const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [
  n >>> 24,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const u32le = (n: number) => u32be(n).reverse();

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRCs are left zero: nothing before the decoder reads them. */
const pngChunk = (type: string, data: number[] = []) => [
  ...u32be(data.length),
  ...ascii(type),
  ...data,
  0,
  0,
  0,
  0,
];

const ihdr = (width: number, height: number) =>
  pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]);

export const pngHeader = (width: number, height: number) =>
  new Uint8Array([
    ...PNG_SIGNATURE,
    ...ihdr(width, height),
    ...pngChunk('IDAT'),
    ...pngChunk('IEND'),
  ]);

export const STATIC_PNG = pngHeader(1, 1);

export const ANIMATED_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...ihdr(1, 1),
  ...pngChunk('acTL', [...u32be(2), ...u32be(0)]),
  ...pngChunk('IDAT'),
  ...pngChunk('IEND'),
]);

/** `IHDR` must come first; without it no size can be read. */
export const HEADLESS_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...pngChunk('IDAT'),
  ...pngChunk('IEND'),
]);

const VP8X_ANIMATION_FLAG = 0x02;
const vp8x = [
  ...ascii('VP8X'),
  ...u32le(10),
  VP8X_ANIMATION_FLAG,
  ...Array.from({ length: 9 }, () => 0),
];

export const ANIMATED_WEBP = new Uint8Array([
  ...ascii('RIFF'),
  ...u32le(4 + vp8x.length),
  ...ascii('WEBP'),
  ...vp8x,
]);

const jpegSegment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  ...u16be(payload.length + 2),
  ...payload,
];

const startOfFrame = (marker: number, width: number, height: number) =>
  jpegSegment(marker, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]);

/**
 * An EXIF segment holding a thumbnail's frame header first, as cameras write
 * it: a reader that scans for the first `FFC0` reads the thumbnail's size.
 */
export function jpegHeader(
  width: number,
  height: number,
  { progressive = false, thumbnail = false } = {}
) {
  return new Uint8Array([
    0xff,
    0xd8,
    ...(thumbnail
      ? jpegSegment(0xe1, [
          ...ascii('Exif'),
          0,
          0,
          ...startOfFrame(0xc0, 160, 120),
        ])
      : []),
    ...jpegSegment(
      0xdb,
      Array.from({ length: 65 }, () => 1)
    ),
    ...startOfFrame(progressive ? 0xc2 : 0xc0, width, height),
    ...jpegSegment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0xff,
    0xd9,
  ]);
}

/** A scan with no frame header before it. */
export const FRAMELESS_JPEG = new Uint8Array([
  0xff,
  0xd8,
  ...jpegSegment(0xda, [1, 1, 0, 0, 0x3f, 0]),
  0xff,
  0xd9,
]);

const box = (type: string, payload: number[]) => [
  ...u32be(payload.length + 8),
  ...ascii(type),
  ...payload,
];

const fullBox = (type: string, payload: number[]) =>
  box(type, [0, 0, 0, 0, ...payload]);

const ispe = (width: number, height: number) =>
  fullBox('ispe', [...u32be(width), ...u32be(height)]);

/**
 * A HEIC's `ftyp` and item properties, with one `ispe` per size given (the
 * primary image, a grid canvas, a thumbnail), and a `moov` sequence track when
 * `sequence` is set.
 */
export function heicHeader(
  sizes: readonly (readonly [number, number])[],
  { sequence = false } = {}
) {
  return new Uint8Array([
    ...box('ftyp', [...ascii('heic'), 0, 0, 0, 0, ...ascii('mif1heic')]),
    ...fullBox('meta', [
      ...fullBox('hdlr', [0, 0, 0, 0, ...ascii('pict'), ...u32be(0), 0]),
      ...box('iprp', [
        ...box(
          'ipco',
          sizes.flatMap(([width, height]) => ispe(width, height))
        ),
      ]),
    ]),
    ...(sequence ? box('moov', box('mvhd', u32be(0))) : []),
  ]);
}

export const GIF = new Uint8Array([
  ...ascii('GIF89a'),
  ...u16be(1).reverse(),
  ...u16be(1).reverse(),
  0,
  0,
  0,
  0x3b,
]);
