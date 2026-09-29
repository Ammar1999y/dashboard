import { create } from 'zustand';

// LANGUAGES-TODOS: the active content language joins this store.
interface TabsState {
  activeMainTab: string | null;
  hoveredMainTab: string | null;
  setActiveMainTab: (tab: string) => void;
  setHoveredMainTab: (tab: string | null) => void;
  reset: () => void;
}

const INITIAL = { activeMainTab: null, hoveredMainTab: null };

/** One tab strip is mounted at a time; `FormTabs` resets it on unmount. */
export const useTabsStore = create<TabsState>((set) => ({
  ...INITIAL,
  setActiveMainTab: (tab) => set({ activeMainTab: tab }),
  setHoveredMainTab: (tab) => set({ hoveredMainTab: tab }),
  reset: () => set(INITIAL),
}));
