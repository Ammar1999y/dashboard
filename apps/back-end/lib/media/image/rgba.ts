/**
 * `Bun.Image` has no raw terminal or `ensureAlpha()`, so the pipeline encodes an
 * uncompressed PNG and this module reads it back. Only the PNGs it just produced
 * (8-bit, non-interlaced, colour type 0/2/4/6) are accepted: a general decoder
 * is a much larger surface than this needs.
 */
import { boundedImage } from './bounded';

const CHANNELS_BY_COLOUR_TYPE: Record<number, number> = {
  0: 1, // greyscale
  2: 3, // truecolour
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
};

const PNG_SIGNATURE = 0x89_50_4e_47;

type DecodedPng = {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
};

/** PNG spec §9.2. All five: Bun's encoder picks per row and uses several. */
function unfilter(
  filter: number | undefined,
  value: number,
  left: number,
  up: number,
  upLeft: number
): number {
  switch (filter) {
    case 0: {
      return value;
    }
    case 1: {
      return value + left;
    }
    case 2: {
      return value + up;
    }
    case 3: {
      return value + ((left + up) >> 1);
    }
    case 4: {
      const estimate = left + up - upLeft;
      const dLeft = Math.abs(estimate - left);
      const dUp = Math.abs(estimate - up);
      const dUpLeft = Math.abs(estimate - upLeft);
      if (dLeft <= dUp && dLeft <= dUpLeft) return value + left;
      return value + (dUp <= dUpLeft ? up : upLeft);
    }
    default: {
      throw new Error(`rgba: unknown PNG filter ${filter}`);
    }
  }
}

function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || buf.readUInt32BE(0) !== PNG_SIGNATURE)
    throw new Error('rgba: not a PNG');

  // The spec mandates IHDR first, so it is read at its fixed offset.
  if (buf.length < 33 || buf.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('rgba: PNG without a leading IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24] ?? 0;
  const colourType = buf[25] ?? 0;
  const interlace = buf[28] ?? 0;

  // Every IDAT found is concatenated; their required adjacency is not checked.
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IEND') break;
    if (type === 'IDAT')
      idat.push(buf.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  if (bitDepth !== 8)
    throw new Error(`rgba: unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('rgba: interlaced PNG');
  const channels = CHANNELS_BY_COLOUR_TYPE[colourType];
  if (!channels) throw new Error(`rgba: unsupported colour type ${colourType}`);
  if (width <= 0 || height <= 0) throw new Error('rgba: empty PNG');

  const stride = width * channels;
  // `windowBits: 15` is required: `Bun.inflateSync` defaults to RAW deflate,
  // and a PNG's IDAT stream is zlib-wrapped.
  const raw = Buffer.from(
    Bun.inflateSync(Buffer.concat(idat), { windowBits: 15 })
  );
  if (raw.length < (stride + 1) * height) throw new Error('rgba: short IDAT');

  const out = Buffer.alloc(stride * height);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const row = raw.subarray(read, read + stride);
    read += stride;
    const current = out.subarray(y * stride, y * stride + stride);
    const previous =
      y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (current[i - channels] ?? 0) : 0;
      const up = previous ? (previous[i] ?? 0) : 0;
      const upLeft =
        previous && i >= channels ? (previous[i - channels] ?? 0) : 0;
      current[i] = unfilter(filter, row[i] ?? 0, left, up, upLeft) & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/** The `ensureAlpha()` a `Bun.Image` pipeline cannot express. */
function toRgba({ width, height, channels, data }: DecodedPng): Buffer {
  if (channels === 4) return data;
  const pixels = width * height;
  const out = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const source = i * channels;
    const first = data[source] ?? 0;
    const colour = channels >= 3;
    out[i * 4] = first;
    out[i * 4 + 1] = colour ? (data[source + 1] ?? 0) : first;
    out[i * 4 + 2] = colour ? (data[source + 2] ?? 0) : first;
    out[i * 4 + 3] = channels === 2 ? (data[source + 1] ?? 255) : 255;
  }
  return out;
}

export async function imageToRgba(
  input: Buffer,
  size: number
): Promise<{ width: number; height: number; rgba: Buffer }> {
  const png = await boundedImage(input)
    .resize(size, size, { fit: 'inside' })
    .png({ compressionLevel: 0 })
    .bytes();
  const decoded = decodePng(png);
  return {
    width: decoded.width,
    height: decoded.height,
    rgba: toRgba(decoded),
  };
}
