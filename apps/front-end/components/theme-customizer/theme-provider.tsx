import type { ThemeMode } from './types';
import type { Attribute } from 'next-themes';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';

import {
  ThemeProvider as NextThemeProvider,
  useTheme as useNextTheme,
} from 'next-themes';
import { flushSync } from 'react-dom';

import { useEditorStore } from './store';
import { NEXT_THEME_STORAGE_KEY, saveThemeSnapshot } from './theme-snapshot';
import { applyCssVars, computeRootVars, computeThemeVars } from './theme-vars';

type Point = { x: number; y: number };

const NEXT_THEME_ATTRIBUTES: Attribute[] = ['class', 'data-theme'];

const isThemeMode = (value: string | undefined): value is ThemeMode =>
  value === 'light' || value === 'dark';

const ThemeStyleSync = memo(() => {
  const { resolvedTheme } = useNextTheme();
  const styles = useEditorStore((s) => s.themeState.styles);
  const containerStretch = useEditorStore((s) => s.containerStretch);
  const fontScale = useEditorStore((s) => s.fontScale);

  const themeVars = useMemo(
    () => ({
      light: computeThemeVars(styles, 'light'),
      dark: computeThemeVars(styles, 'dark'),
    }),
    [styles]
  );
  const rootVars = useMemo(
    () => computeRootVars(containerStretch, fontScale),
    [containerStretch, fontScale]
  );

  useLayoutEffect(() => {
    if (isThemeMode(resolvedTheme))
      applyCssVars(document.documentElement, themeVars[resolvedTheme]);
  }, [themeVars, resolvedTheme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.removeProperty('--container-max-width');
    applyCssVars(root, rootVars);
  }, [rootVars]);

  useEffect(() => {
    saveThemeSnapshot({ ...themeVars, root: rootVars });
  }, [themeVars, rootVars]);

  return null;
});
ThemeStyleSync.displayName = 'ThemeStyleSync';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute={NEXT_THEME_ATTRIBUTES}
      storageKey={NEXT_THEME_STORAGE_KEY}
    >
      <ThemeStyleSync />
      {children}
    </NextThemeProvider>
  );
}

export function useThemeMode() {
  const { resolvedTheme, setTheme } = useNextTheme();

  const setMode = useCallback(
    (mode: ThemeMode, origin?: Point) => {
      if (!document.startViewTransition) {
        setTheme(mode);
        return;
      }
      if (origin) {
        const { style } = document.documentElement;
        style.setProperty('--x', `${origin.x}px`);
        style.setProperty('--y', `${origin.y}px`);
      }
      // The transition snapshots the DOM when the callback returns, so the
      // theme must be committed synchronously inside it.
      document.startViewTransition(() => flushSync(() => setTheme(mode)));
    },
    [setTheme]
  );

  return {
    mode: isThemeMode(resolvedTheme) ? resolvedTheme : undefined,
    setMode,
  };
}
