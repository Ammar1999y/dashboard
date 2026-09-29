import type { CssVars } from './theme-snapshot';
import type { ThemeMode, ThemeStyles } from './types';

import { colorFormatter } from '@/utils/color-converter';

import { COMMON_STYLES } from './config';

const COMMON_STYLE_KEYS: ReadonlySet<string> = new Set(COMMON_STYLES);

function toColorChannels(key: string, value: string) {
  if (value.startsWith('var(')) return value;
  const channels = colorFormatter(value, 'hsl', '4', true);
  // theme-tokens.css appends its own alpha: `hsl(var(--shadow-color) / 0.1)`.
  return key === 'shadow-color' ? channels.split(' / ', 1)[0] : channels;
}

export function computeThemeVars(
  styles: ThemeStyles,
  mode: ThemeMode
): CssVars {
  const vars: CssVars = {};
  const common = Object.entries(styles.light);
  const modeSpecific = Object.entries(styles[mode]);

  // `styles` comes back from localStorage unchecked, hence the string guards.
  for (const [key, value] of common) {
    if (typeof value === 'string' && COMMON_STYLE_KEYS.has(key))
      vars[`--${key}`] = value;
  }
  for (const [key, value] of modeSpecific) {
    if (typeof value !== 'string' || COMMON_STYLE_KEYS.has(key)) continue;
    vars[`--${key}`] = toColorChannels(key, value);
  }
  return vars;
}

// Unstretched omits the width so theme-tokens.css keeps owning its value.
export function computeRootVars(
  containerStretch: boolean,
  fontScale: number
): CssVars {
  const vars: CssVars = { '--font-scale': String(fontScale) };
  if (containerStretch) vars['--container-max-width'] = '100%';
  return vars;
}

export function applyCssVars(root: HTMLElement, vars: CssVars) {
  for (const [key, value] of Object.entries(vars))
    root.style.setProperty(key, value);
}
