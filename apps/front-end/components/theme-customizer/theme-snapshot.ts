import type { ThemeMode } from './types';

export type CssVars = Record<string, string>;

export type ThemeSnapshot = Record<ThemeMode, CssVars> & { root: CssVars };

export const NEXT_THEME_STORAGE_KEY = 'theme';

const SNAPSHOT_STORAGE_KEY = 'theme-vars';

export function saveThemeSnapshot(snapshot: ThemeSnapshot) {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}

// Serialized by `toString()` into a <head> script: no imports, no closures.
// Resolves the mode the way next-themes does (default `system`).
function restoreThemeSnapshot(snapshotKey: string, themeKey: string) {
  try {
    const raw = localStorage.getItem(snapshotKey);
    if (!raw) return;
    const snapshot: Partial<ThemeSnapshot> = JSON.parse(raw);
    const theme = localStorage.getItem(themeKey);
    const mode =
      theme === 'light' || theme === 'dark'
        ? theme
        : matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    const vars: CssVars = Object.assign({}, snapshot.root, snapshot[mode]);
    const { style } = document.documentElement;
    for (const [key, value] of Object.entries(vars))
      style.setProperty(key, value);
  } catch {}
}

export const THEME_SNAPSHOT_SCRIPT = `(${restoreThemeSnapshot.toString()})(${JSON.stringify(SNAPSHOT_STORAGE_KEY)},${JSON.stringify(NEXT_THEME_STORAGE_KEY)})`;
