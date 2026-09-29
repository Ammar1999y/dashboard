import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export enum ThemeLayout {
  Vertical = 'vertical',
  Horizontal = 'horizontal',
  Mini = 'mini',
}

type SettingsType = {
  themeLayout: ThemeLayout;
};
type SettingStore = {
  settings: SettingsType;
  actions: {
    setThemeLayout: (themeLayout: ThemeLayout) => void;
  };
};

const STORAGE_KEY = 'settings';

export const useSettingStore = create<SettingStore>()(
  persist(
    (set) => ({
      settings: {
        themeLayout: ThemeLayout.Vertical,
      },
      actions: {
        setThemeLayout: (themeLayout) => {
          set((state) => ({ settings: { ...state.settings, themeLayout } }));
        },
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);

export const useThemeLayout = () =>
  useSettingStore((state) => state.settings.themeLayout);
