import { toUnitLess } from '@platejs/basic-styles';

const FONT_SIZE_MIN = 1;
export const FONT_SIZE_MAX = 100;
/** What unmarked body text renders at (`text-base`). */
export const BASE_FONT_SIZE = 16;

export const FONT_SIZE_PRESETS = [
  8, 9, 10, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72, 96,
];

/** The size headings render at, for the toolbar's readout. */
export const HEADING_FONT_SIZES: Record<string, number> = {
  h1: 36,
  h2: 24,
  h3: 20,
};

/** A typed or stored size in px, or `null` when it is not a usable size. */
export function parseFontSize(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const size = Math.trunc(Number(toUnitLess(String(value))));
  return Number.isFinite(size) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX
    ? size
    : null;
}

export const stepFontSize = (current: number | null, delta: number) =>
  Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, (current ?? BASE_FONT_SIZE) + delta)
  );
