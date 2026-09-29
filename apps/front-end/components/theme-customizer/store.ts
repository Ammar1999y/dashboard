import type { CommonStyle } from './config';
import type { ThemeEditorState } from './types';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDialog, DIALOG_URL_IDS } from '@/lib/dialogs';

import { DEFAULT_FONT_SCALE, DEFAULT_THEME_STYLES } from './config';

export const themeCustomizerDialog = createDialog({
  urlId: DIALOG_URL_IDS.themeCustomizer,
  restoreFromUrl: true,
});

type EditorState = {
  themeState: ThemeEditorState;
  containerStretch: boolean;
  fontScale: number;
};

type EditorActions = {
  setThemeState: (themeState: ThemeEditorState) => void;
  setCommonStyle: (key: CommonStyle, value: string) => void;
  setContainerStretch: (value: boolean) => void;
  setFontScale: (value: number) => void;
  reset: () => void;
};

const initialState: EditorState = {
  themeState: { styles: DEFAULT_THEME_STYLES },
  containerStretch: false,
  fontScale: DEFAULT_FONT_SCALE,
};

export const useEditorStore = create<EditorState & EditorActions>()(
  persist(
    (set) => ({
      ...initialState,
      setThemeState: (themeState) => set({ themeState }),
      setCommonStyle: (key, value) =>
        set(({ themeState }) => ({
          themeState: {
            ...themeState,
            styles: {
              light: { ...themeState.styles.light, [key]: value },
              dark: { ...themeState.styles.dark, [key]: value },
            },
          },
        })),
      setContainerStretch: (containerStretch) => set({ containerStretch }),
      setFontScale: (fontScale) => set({ fontScale }),
      reset: () => set(initialState),
    }),
    { name: 'editor-storage-2' }
  )
);
