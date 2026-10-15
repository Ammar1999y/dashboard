/*
 * Decodes the BlurHash the server stores for a raster image
 * (https://github.com/woltapp/blurhash, algorithm in its README), which stands
 * in for a private image in lists: the image itself is fetched only where it
 * is opened.
 */

const DIGITS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(text: string, from: number, to: number): number | null {
  let value = 0;
  for (let index = from; index < to; index++) {
    const digit = DIGITS.indexOf(text.charAt(index));
    if (digit === -1) return null;
    value = value * 83 + digit;
  }
  return value;
}

const toLinear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const toSrgb = (linear: number) => {
  const value = Math.max(0, Math.min(1, linear));
  const encoded =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.trunc(encoded * 255 + 0.5);
};

const NO_COLOR: readonly [number, number, number] = [0, 0, 0];

const signedPow = (value: number, exponent: number) =>
  Math.sign(value) * Math.abs(value) ** exponent;

/**
 * RGBA pixels for a `width` × `height` image, or `null` for a hash that is not
 * one: the caller then shows no placeholder rather than a wrong one.
 */
export function decodeBlurhash(
  hash: string,
  width: number,
  height: number
): Uint8ClampedArray | null {
  if (hash.length < 6) return null;
  const sizeFlag = decode83(hash, 0, 1);
  const quantisedMax = decode83(hash, 1, 2);
  if (sizeFlag === null || quantisedMax === null) return null;
  const columns = (sizeFlag % 9) + 1;
  const rows = Math.floor(sizeFlag / 9) + 1;
  if (hash.length !== 4 + 2 * columns * rows) return null;
  const maxValue = (quantisedMax + 1) / 166;

  const colors: [number, number, number][] = [];
  for (let index = 0; index < columns * rows; index++) {
    if (index === 0) {
      const value = decode83(hash, 2, 6);
      if (value === null) return null;
      colors.push([
        toLinear(value >> 16),
        toLinear((value >> 8) & 255),
        toLinear(value & 255),
      ]);
    } else {
      const value = decode83(hash, 4 + index * 2, 6 + index * 2);
      if (value === null) return null;
      colors.push([
        signedPow((Math.floor(value / (19 * 19)) - 9) / 9, 2) * maxValue,
        signedPow(((Math.floor(value / 19) % 19) - 9) / 9, 2) * maxValue,
        signedPow(((value % 19) - 9) / 9, 2) * maxValue,
      ]);
    }
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < columns; i++) {
          const basis =
            Math.cos((Math.PI * x * i) / width) *
            Math.cos((Math.PI * y * j) / height);
          const [r, g, b] = colors[i + j * columns] ?? NO_COLOR;
          red += r * basis;
          green += g * basis;
          blue += b * basis;
        }
      const offset = 4 * (x + y * width);
      pixels[offset] = toSrgb(red);
      pixels[offset + 1] = toSrgb(green);
      pixels[offset + 2] = toSrgb(blue);
      pixels[offset + 3] = 255;
    }
  return pixels;
}
