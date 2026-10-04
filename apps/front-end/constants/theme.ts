import { hslToRgb, rgbToHex } from '@/utils/color-converter';

const PRIMARY_HUE = 172;
const PRIMARY_SATURATION = 98;

const PRIMARY_LIGHTNESS = { dark: 32, base: 40, light: 48 } as const;

/** The `H S% L%` channel form consumed by `hsl(var(--primary))`. */
const triplet = (lightness: number) =>
  `${PRIMARY_HUE} ${PRIMARY_SATURATION}% ${lightness}%`;

export const PRIMARY_THEME_VALUES = {
  primary: triplet(PRIMARY_LIGHTNESS.base),
  'primary-light': triplet(PRIMARY_LIGHTNESS.light),
  'primary-dark': triplet(PRIMARY_LIGHTNESS.dark),
} as const;

/** Custom properties emitted into `:root` by the Tailwind base plugin. */
export const PRIMARY_CSS_VARIABLES: Record<string, string> = {
  '--primary': PRIMARY_THEME_VALUES.primary,
  '--primary-light': PRIMARY_THEME_VALUES['primary-light'],
  '--primary-dark': PRIMARY_THEME_VALUES['primary-dark'],
};

const primaryRgb = hslToRgb(
  PRIMARY_HUE,
  PRIMARY_SATURATION,
  PRIMARY_LIGHTNESS.base
);

/** Hex is required by HTML metadata and the web app manifest. */
export const PRIMARY_HEX = rgbToHex(primaryRgb.r, primaryRgb.g, primaryRgb.b);
