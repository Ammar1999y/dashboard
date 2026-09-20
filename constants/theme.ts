const PRIMARY_HUE = 172;
const PRIMARY_SATURATION = 98;

/** Lightness steps derived from the brand hue. */
const PRIMARY_LIGHTNESS = { dark: 32, base: 40, light: 48 } as const;

/** The `H S% L%` channel form consumed by `hsl(var(--primary))`. */
const triplet = (lightness: number) =>
  `${PRIMARY_HUE} ${PRIMARY_SATURATION}% ${lightness}%`;

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Default theme values used by the theme customizer. */
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

/** Hex is required by HTML metadata and the web app manifest. */
export const PRIMARY_HEX = hslToHex(
  PRIMARY_HUE,
  PRIMARY_SATURATION,
  PRIMARY_LIGHTNESS.base
);
