import type { ItemKey } from '@/lib/media/keys';
import type { LibraryFilters, LibrarySort } from '@/lib/media/listing';
import type { EntityID } from '@app/shared/types';

import { create } from 'zustand';
import { DEFAULT_SORT, NO_FILTERS } from '@/lib/media/listing';

export const VIEWS = ['columns', 'grid', 'list'] as const;
export type View = (typeof VIEWS)[number];

/** What the library lists: the folder tree, or every file flat. */
export type Mode = 'folders' | 'all' | 'unfiled';

/** Where a search looks from inside a folder. */
export type SearchScope = 'all' | 'folder';

type Editing =
  { kind: 'rename'; key: ItemKey } | { kind: 'new'; parent: EntityID | null };

/** One step of the back and forward history: the opened folders from the root. */
type Path = readonly (EntityID | null)[];

interface BrowserState {
  view: View;
  /** The details panel, or column in the column view. */
  inspector: boolean;
  /** The grid's tile width, in pixels. */
  tileSize: number;
  /** Column widths by column index, and the inspector's under `inspector`. */
  widths: Readonly<Record<string, number>>;
  /** The opened folders from the root, which `path[0]` (`null`) is. */
  path: Path;
  history: readonly Path[];
  historyIndex: number;
  sort: LibrarySort;
  filters: LibraryFilters;
  mode: Mode;
  /** What the search box holds, applied as `query` once the server reads it. */
  searchText: string;
  /** The search applied, a term the server reads or `''`. */
  query: string;
  /** The folder the applied search is limited to; `null` is the whole library. */
  queryFolder: EntityID | null;
  searchScope: SearchScope;
  /** The list view's opened folders. */
  expanded: ReadonlySet<EntityID>;
  editing: Editing | null;
  /** A column to select the first item of once its listing is there. */
  pendingFocus: number | null;
  /** An item to select once the folder it is in is listed. */
  reveal: ItemKey | null;
  /** An item just created or renamed, highlighted for a moment. */
  flash: ItemKey | null;
  /** Writes in flight that the status bar reports. */
  busy: number;
}

const DEFAULT_TILE_SIZE = 150;
export const TILE_SIZE_RANGE = { min: 90, max: 280, step: 5 } as const;
export const DEFAULT_COLUMN_WIDTH = 248;
export const DEFAULT_INSPECTOR_WIDTH = 340;
export const COLUMN_WIDTH_RANGE = { min: 170, max: 680 } as const;
/** The details panel starts open on a viewport at least this wide. */
const INSPECTOR_MIN_VIEWPORT = 900;
const HISTORY_MAX = 60;

const VIEW_STORAGE_KEY = 'media-view';

const ROOT_PATH: Path = [null];

function storedView(): View {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    return VIEWS.find((view) => view === stored) ?? 'columns';
  } catch {
    return 'columns';
  }
}

export function storeView(view: View) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage off or full: the view is still the one chosen, until a reload.
  }
}

const initialState = (): BrowserState => ({
  view: 'columns',
  inspector: true,
  tileSize: DEFAULT_TILE_SIZE,
  widths: {},
  path: ROOT_PATH,
  history: [ROOT_PATH],
  historyIndex: 0,
  sort: DEFAULT_SORT,
  filters: NO_FILTERS,
  mode: 'folders',
  searchText: '',
  query: '',
  queryFolder: null,
  searchScope: 'all',
  expanded: new Set(),
  editing: null,
  pendingFocus: null,
  reveal: null,
  flash: null,
  busy: 0,
});

export const useBrowser = create<BrowserState>(initialState);

export const getBrowser = () => useBrowser.getState();

/** A fresh library for a mount: what the browser stores, and nothing of the last visit. */
export function resetBrowser(folder: EntityID | null) {
  const path: Path = folder ? [null, folder] : ROOT_PATH;
  useBrowser.setState(
    {
      ...initialState(),
      view: storedView(),
      inspector: innerWidth >= INSPECTOR_MIN_VIEWPORT,
      path,
      history: [path],
    },
    true
  );
}

/** The folder the user is in: the deepest opened one. */
export const currentFolder = (path: Path): EntityID | null =>
  path[path.length - 1] ?? null;

/** Whether the library lists a search or every file instead of the tree. */
export const isResults = (
  state: Pick<BrowserState, 'query' | 'mode'>
): boolean => state.query !== '' || state.mode !== 'folders';

const samePath = (a: Path, b: Path) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** `path` opened, as a new history step unless `fromHistory`. */
export function setPath(path: Path, { fromHistory = false } = {}) {
  const state = getBrowser();
  if (samePath(state.path, path)) return;
  if (fromHistory) {
    useBrowser.setState({ path });
    return;
  }
  const kept = state.history.slice(0, state.historyIndex + 1);
  const last = kept[kept.length - 1];
  const history =
    last && samePath(last, path) ? kept : [...kept, path].slice(-HISTORY_MAX);
  useBrowser.setState({ path, history, historyIndex: history.length - 1 });
}

/** Counts a write the status bar reports while it runs. */
export async function trackBusy<T>(work: () => Promise<T>): Promise<T> {
  useBrowser.setState(({ busy }) => ({ busy: busy + 1 }));
  try {
    return await work();
  } finally {
    useBrowser.setState(({ busy }) => ({ busy: busy - 1 }));
  }
}
