import { colorFormatter, hslToRgb, rgbToHex } from '@/utils/color-converter';

const PRIMARY_HUE = 172;
const PRIMARY_SATURATION = 98;
const PRIMARY_LIGHTNESS = 40;

/** The `H S% L%` channel form consumed by `hsl(var(--primary))`. */
const PRIMARY = `${PRIMARY_HUE} ${PRIMARY_SATURATION}% ${PRIMARY_LIGHTNESS}%`;

const SHADES = { 'primary-light': '#4FEED2', 'primary-dark': '#00A78D' };

/**
 * The shades and ink are what `fixContrast` (`scripts/lib/theme-contrast.ts`)
 * derives from `PRIMARY`; its test fails when they drift.
 */
export const PRIMARY_THEME_VALUES = {
  light: { primary: PRIMARY, ...SHADES, 'primary-ink': '#007663' },
  dark: { primary: PRIMARY, ...SHADES, 'primary-ink': PRIMARY },
} as const;

type Mode = keyof typeof PRIMARY_THEME_VALUES;

function channels(value: string) {
  const hsl = colorFormatter(value, 'hsl', '4', true);
  if (hsl === null) throw new TypeError(`Not a color: ${value}`);
  return hsl;
}

const cssVariables = (mode: Mode): Record<string, string> =>
  Object.fromEntries(
    Object.entries(PRIMARY_THEME_VALUES[mode]).map(([key, value]) => [
      `--${key}`,
      channels(value),
    ])
  );

/** Custom properties the Tailwind base plugin emits, per mode. */
export const PRIMARY_CSS_VARIABLES = {
  light: cssVariables('light'),
  dark: cssVariables('dark'),
} as const;

const primaryRgb = hslToRgb(PRIMARY_HUE, PRIMARY_SATURATION, PRIMARY_LIGHTNESS);

/** Hex is required by HTML metadata and the web app manifest. */
export const PRIMARY_HEX = rgbToHex(primaryRgb.r, primaryRgb.g, primaryRgb.b);
