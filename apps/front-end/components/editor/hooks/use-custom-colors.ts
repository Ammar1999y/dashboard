import { useEffect } from 'react';

import { create } from 'zustand';

import { getColorSchema } from '@/utils/validation/rules';

const STORAGE_KEY = 'plate-editor-custom-colors';
const MAX_CUSTOM_COLORS = 10;

// prettier-ignore
export const DEFAULT_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#0000FF', '#9900FF', '#FF00FF',
  '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#CFE2F3', '#D9D2E9', '#EAD1DC',
  '#DD7E6B', '#EA9999', '#F9CB9C', '#FFE599', '#B6D7A8', '#A2C4C9', '#A4C2F4', '#9FC5E8', '#B4A7D6', '#D5A6BD',
  '#CC4125', '#E06666', '#F6B26B', '#FFD966', '#93C47D', '#76A5AF', '#6D9EEB', '#6FA8DC', '#8E7CC3', '#C27BA0',
  '#A61C00', '#CC0000', '#E69138', '#F1C232', '#6AA84F', '#45818E', '#3C78D8', '#3D85C6', '#674EA7', '#A64D79',
  '#85200C', '#990000', '#B45F06', '#BF9000', '#38761D', '#134F5C', '#1155CC', '#0B5394', '#351C75', '#741B47',
  '#5B0F00', '#660000', '#783F04', '#7F6000', '#274E12', '#0D343D', '#1B4487', '#083763', '#1F124D', '#4C1130',
];

const colorSchema = getColorSchema();

/** Stored entries were `{ value }` objects before they were plain strings. */
function readStored(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '[]'
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'value' in entry
          ? entry.value
          : entry
      )
      .flatMap((entry) => {
        const color = colorSchema.safeParse(entry);
        return color.success && color.data ? [color.data] : [];
      })
      .slice(0, MAX_CUSTOM_COLORS);
  } catch {
    return [];
  }
}

function writeStored(colors: string[]) {
  try {
    if (colors.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // Storage is optional: the colors still apply for this session.
  }
}

interface CustomColorsState {
  colors: string[] | null;
  add: (color: string) => void;
  clear: () => void;
}

/** One list for every color menu on the page, read from storage on first use. */
const useCustomColorsStore = create<CustomColorsState>((set, get) => ({
  colors: null,
  add: (color) => {
    const value = color.toUpperCase();
    const current = get().colors ?? readStored();
    if (current.includes(value)) return;
    const colors = [value, ...current].slice(0, MAX_CUSTOM_COLORS);
    writeStored(colors);
    set({ colors });
  },
  clear: () => {
    writeStored([]);
    set({ colors: [] });
  },
}));

const EMPTY: string[] = [];

export function useCustomColors() {
  const colors = useCustomColorsStore((s) => s.colors);

  useEffect(() => {
    if (useCustomColorsStore.getState().colors === null) {
      useCustomColorsStore.setState({ colors: readStored() });
    }
  }, []);

  const { add, clear } = useCustomColorsStore.getState();
  return {
    customColors: colors ?? EMPTY,
    addCustomColor: add,
    clearCustomColors: clear,
  };
}
