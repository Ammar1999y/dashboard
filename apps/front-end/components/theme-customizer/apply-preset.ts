import type { ThemeStyles } from './types';

import { DEFAULT_THEME_STYLES } from './config';
import { themePresets } from './presets';
import { useEditorStore } from './store';

export function getPresetThemeStyles(name: string): ThemeStyles {
  const preset = themePresets[name];
  if (!preset) return DEFAULT_THEME_STYLES;

  return {
    light: { ...DEFAULT_THEME_STYLES.light, ...preset.styles.light },
    dark: {
      ...DEFAULT_THEME_STYLES.dark,
      ...preset.styles.light,
      ...preset.styles.dark,
    },
  };
}

export const applyPreset = (name: string) =>
  useEditorStore
    .getState()
    .setThemeState({ preset: name, styles: getPresetThemeStyles(name) });
