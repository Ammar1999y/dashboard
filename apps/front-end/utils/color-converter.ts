import type { ColorInstance } from 'color';

import Color from 'color';

type ColorFormat = 'hex' | 'rgb' | 'hsl';

/** Throws on a value the `color` parser cannot read. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const color = Color(hex);
  return { r: color.red(), g: color.green(), b: color.blue() };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return Color.rgb(r, g, b).hex();
}

export function rgbToHsl(
  r: number,
  g: number,
  b: number
): { h: number; s: number; l: number } {
  const color = Color.rgb(r, g, b).hsl();
  return {
    h: Math.round(color.hue()),
    s: Math.round(color.saturationl()),
    l: Math.round(color.lightness()),
  };
}

export function hslToRgb(
  h: number,
  s: number,
  l: number
): { r: number; g: number; b: number } {
  const color = Color.hsl(h, s, l);
  return {
    r: Math.round(color.red()),
    g: Math.round(color.green()),
    b: Math.round(color.blue()),
  };
}

/** Throws on a value the `color` parser cannot read. */
export function hexToRgba(hex: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  const color = Color(hex);
  return {
    r: color.red(),
    g: color.green(),
    b: color.blue(),
    a: color.alpha(),
  };
}

/** `hex()` drops the alpha channel; `hexa()` always writes it. */
const toHex = (color: ColorInstance) =>
  color.alpha() < 1 ? color.hexa() : color.hex();

export function rgbaToHex(r: number, g: number, b: number, a: number): string {
  return toHex(Color.rgb(r, g, b).alpha(a));
}

export function rgbaToHsla(
  r: number,
  g: number,
  b: number,
  a: number
): { h: number; s: number; l: number; a: number } {
  const color = Color.rgb(r, g, b).alpha(a).hsl();
  return {
    h: Math.round(color.hue()),
    s: Math.round(color.saturationl()),
    l: Math.round(color.lightness()),
    a: color.alpha(),
  };
}

export function hslaToRgba(
  h: number,
  s: number,
  l: number,
  a: number
): { r: number; g: number; b: number; a: number } {
  const color = Color.hsl(h, s, l).alpha(a);
  return {
    r: Math.round(color.red()),
    g: Math.round(color.green()),
    b: Math.round(color.blue()),
    a: color.alpha(),
  };
}

const formatNumber = (num: number) => {
  if (!num) return '0';
  return Number.isSafeInteger(num) ? num : num.toFixed(4);
};

/**
 * Any CSS color the `color` parser reads, or the bare `H S% L%` channels the
 * theme stores, which it reads only inside `hsl()`.
 */
function parseColor(value: string): ColorInstance | null {
  for (const candidate of [value, `hsl(${value})`]) {
    try {
      return Color(candidate);
    } catch {
      // Not this form; the next one may read it.
    }
  }
  return null;
}

/** `null` when `colorValue` is not a color. */
export const colorFormatter = (
  colorValue: string,
  format: ColorFormat = 'hsl',
  tailwindVersion: '3' | '4' = '3',
  valuesOnly: boolean = false
): string | null => {
  const color = parseColor(colorValue);
  if (!color) return null;

  switch (format) {
    case 'hsl': {
      const { h, s, l } = color.hsl().object();
      const alpha = color.alpha();
      const values = `${formatNumber(h || 0)} ${formatNumber(s)}% ${formatNumber(l)}%${
        alpha === 1 ? '' : ` / ${alpha}`
      }`;
      return tailwindVersion === '4' && !valuesOnly ? `hsl(${values})` : values;
    }
    case 'rgb': {
      return color.rgb().string();
    }
    case 'hex': {
      return toHex(color);
    }
  }
};
