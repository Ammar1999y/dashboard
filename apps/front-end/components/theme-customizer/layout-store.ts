import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { THEME_LAYOUTS } from '@app/shared/validation/preferences';

export type ThemeLayout = (typeof THEME_LAYOUTS)[number];

export const ThemeLayout = {
  Vertical: 'vertical',
  Horizontal: 'horizontal',
  Mini: 'mini',
} as const satisfies Record<string, ThemeLayout>;

type SettingStore = {
  settings: { themeLayout: ThemeLayout };
  actions: {
    setThemeLayout: (themeLayout: ThemeLayout) => void;
  };
};

const isThemeLayout = (value: unknown): value is ThemeLayout =>
  (THEME_LAYOUTS as readonly unknown[]).includes(value);

export const useSettingStore = create<SettingStore>()(
  persist(
    (set) => ({
      settings: { themeLayout: ThemeLayout.Vertical },
      actions: {
        setThemeLayout: (themeLayout) => {
          set((state) => ({ settings: { ...state.settings, themeLayout } }));
        },
      },
    }),
    {
      name: 'settings',
      partialize: (state) => ({ settings: state.settings }),
      // Storage is the user's to edit: a layout this build does not know
      // falls back to the default instead of rendering no layout.
      merge: (persisted, current) => {
        const stored =
          typeof persisted === 'object' && persisted !== null
            ? Reflect.get(persisted, 'settings')
            : undefined;
        const themeLayout =
          typeof stored === 'object' && stored !== null
            ? Reflect.get(stored, 'themeLayout')
            : undefined;
        return isThemeLayout(themeLayout)
          ? { ...current, settings: { themeLayout } }
          : current;
      },
    }
  )
);

export const useThemeLayout = () =>
  useSettingStore((state) => state.settings.themeLayout);
