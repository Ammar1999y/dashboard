import type { ThemeMode } from './types';

import { SNAPSHOT_STORAGE_KEY } from './theme-script';

export type CssVars = Record<string, string>;

export type ThemeSnapshot = Record<ThemeMode, CssVars> & { root: CssVars };

export function saveThemeSnapshot(snapshot: ThemeSnapshot) {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}
