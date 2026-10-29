import type { ThemePreset, ThemeStyles } from './types';

import { COMMON_STYLES, DEFAULT_THEME_STYLES } from './config';
import { themePresets } from './presets';
import { useEditorStore } from './store';

export function getPresetThemeStyles(name: string): ThemeStyles {
  const preset = themePresets[name];
  return preset ? resolvePresetStyles(preset) : DEFAULT_THEME_STYLES;
}

/** A preset over the defaults; dark falls back to the preset's light values first. */
export function resolvePresetStyles(preset: ThemePreset): ThemeStyles {
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

/**
 * The store keeps the colors of the preset it applied, so a preset changed
 * since (`themes:sync`, its contrast fixes, the default theme) reaches a
 * returning reader only through this. The reader's common styles stay.
 */
export function refreshPresetStyles() {
  const { themeState, setThemeState } = useEditorStore.getState();
  const own = Object.fromEntries(
    COMMON_STYLES.flatMap((key) => {
      const value: unknown = themeState.styles.light[key];
      return typeof value === 'string' ? [[key, value]] : [];
    })
  );
  const registry = getPresetThemeStyles(themeState.preset ?? 'default');
  const styles = {
    light: { ...registry.light, ...own },
    dark: { ...registry.dark, ...own },
  };
  if (JSON.stringify(styles) !== JSON.stringify(themeState.styles))
    setThemeState({ ...themeState, styles });
}
