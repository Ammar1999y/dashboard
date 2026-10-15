import type { Mode, SearchScope, View } from './store';
import type { ItemKey } from '@/lib/media/keys';
import type { LibraryFilters, SortId } from '@/lib/media/listing';
import type {
  ClickModifiers,
  Selection,
  SelectionColumn,
} from '@/lib/media/selection';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { toast } from 'sonner';
import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import { MSG_FILTER_SWITCHED_TO_ALL } from '@/constants/messages';
import { trailOf } from '@/lib/media/cache';
import { fileKey, folderKey, idOfKey, isFolderKey } from '@/lib/media/keys';
import { filterCount } from '@/lib/media/listing';
import {
  cleared,
  clickSelect,
  getSelection,
  keepHeld,
  only,
  selectEvery,
  setSelection,
  stepSelect,
} from '@/lib/media/selection';

import { findItem, itemName, itemParent } from './items';
import {
  currentFolder,
  getBrowser,
  isResults,
  setPath,
  storeView,
  useBrowser,
} from './store';
import { folderSource, readListing, resultsSource } from './use-listing';

/** The list the keyboard and a click range move through now. */
export function viewColumn(): SelectionColumn {
  const state = getBrowser();
  if (isResults(state)) return 'results';
  if (state.view === 'grid') return 'grid';
  if (state.view === 'list') return 'list';
  const { col } = getSelection().cursor;
  const last = state.path.length - 1;
  return typeof col === 'number' ? Math.min(col, last) : last;
}

/** The list of the folder at `depth` of the path, as the view shows it. */
const columnAt = (depth: number): SelectionColumn => {
  const { view } = getBrowser();
  return view === 'columns' ? depth : view;
};

/** The deepest list on screen: the current folder's. */
export function lastColumn(): SelectionColumn {
  const state = getBrowser();
  if (isResults(state)) return 'results';
  if (state.view === 'grid') return 'grid';
  if (state.view === 'list') return 'list';
  return state.path.length - 1;
}

const listingOrder = (
  queryClient: QueryClient,
  folder: EntityID | null
): ItemKey[] => {
  const listing = readListing(queryClient, folderSource(folder));
  if (!listing) return [];
  return [
    ...listing.folders.map(({ id }) => folderKey(id)),
    ...listing.files.map(({ id }) => fileKey(id)),
  ];
};

/** The list view's rows top to bottom, opened folders' contents in place. */
function listRows(queryClient: QueryClient): ItemKey[] {
  const { path, expanded } = getBrowser();
  const rows: ItemKey[] = [];
  const walk = (folder: EntityID | null, seen: ReadonlySet<EntityID>) => {
    const listing = readListing(queryClient, folderSource(folder));
    if (!listing) return;
    for (const { id } of listing.folders) {
      rows.push(folderKey(id));
      if (expanded.has(id) && !seen.has(id)) walk(id, new Set([...seen, id]));
    }
    for (const { id } of listing.files) rows.push(fileKey(id));
  };
  walk(currentFolder(path), new Set());
  return rows;
}

export function columnOrder(
  queryClient: QueryClient,
  col: SelectionColumn
): ItemKey[] {
  const state = getBrowser();
  if (col === 'results') {
    const listing = readListing(queryClient, resultsSource(state));
    return listing
      ? [
          ...listing.folders.map(({ id }) => folderKey(id)),
          ...listing.files.map(({ id }) => fileKey(id)),
        ]
      : [];
  }
  if (col === 'grid')
    return listingOrder(queryClient, currentFolder(state.path));
  if (col === 'list') return listRows(queryClient);
  return listingOrder(queryClient, state.path[col] ?? null);
}

/** Brings an item into view once it is on screen. */
export function scrollToItem(key: ItemKey) {
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-item="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/**
 * Applies a selection. In the column view a folder selected alone opens in the
 * next column, and selecting in an earlier column closes the ones after it.
 */
export function select(next: Selection) {
  setSelection(next);
  // A choice made now replaces one that waited for a column to load.
  if (getBrowser().pendingFocus !== null)
    useBrowser.setState({ pendingFocus: null });
  const state = getBrowser();
  if (state.view !== 'columns' || isResults(state)) return;
  const { cursor, keys } = next;
  if (typeof cursor.col !== 'number') return;
  const col = Math.min(cursor.col, state.path.length - 1);
  const path = state.path.slice(0, col + 1);
  if (
    keys.size === 1 &&
    cursor.key &&
    isFolderKey(cursor.key) &&
    keys.has(cursor.key)
  )
    path.push(idOfKey(cursor.key));
  setPath(path);
}

export function selectOnly(key: ItemKey, col: SelectionColumn) {
  select(only(key, col));
  scrollToItem(key);
}

export const clearSelection = (col?: SelectionColumn) =>
  select(cleared(getSelection(), col));

export function clickItem(
  queryClient: QueryClient,
  key: ItemKey,
  col: SelectionColumn,
  modifiers: ClickModifiers
) {
  select(
    clickSelect(
      getSelection(),
      key,
      col,
      columnOrder(queryClient, col),
      modifiers
    )
  );
}

/** Keeps only what the listings still hold, after a write took some away. */
export function pruneSelection(queryClient: QueryClient) {
  setSelection(
    keepHeld(getSelection(), (key) => findItem(queryClient, key) !== undefined)
  );
}

/** Root to `folder`, as the cache names it, or the folder alone until it is listed. */
export function chainTo(
  queryClient: QueryClient,
  folder: EntityID | null
): EntityID[] {
  if (folder === null) return [];
  return trailOf(queryClient, folder)?.map(({ id }) => id) ?? [folder];
}

export const folderName = (queryClient: QueryClient, folder: EntityID) => {
  const item = findItem(queryClient, folderKey(folder));
  if (item) return itemName(item);
  return trailOf(queryClient, folder)?.find(({ id }) => id === folder)?.name;
};

// ---- Leaving results ------------------------------------------------------

/** Back to the folder tree from a search or the flat list. */
export function exitResults() {
  const state = getBrowser();
  if (!isResults(state)) return;
  useBrowser.setState({
    query: '',
    searchText: '',
    queryFolder: null,
    mode: 'folders',
  });
  setSelection(cleared(getSelection(), lastColumn()));
}

// ---- Navigation -------------------------------------------------------------

/** Opens `folder`, selected in the column it is listed in. */
export function goTo(queryClient: QueryClient, folder: EntityID | null) {
  exitResults();
  const chain = chainTo(queryClient, folder);
  useBrowser.setState({ pendingFocus: null });
  const { view } = getBrowser();
  setSelection(
    view === 'columns' && folder !== null
      ? only(folderKey(folder), chain.length - 1)
      : cleared(
          getSelection(),
          view === 'columns' ? chain.length : lastColumn()
        )
  );
  setPath([null, ...chain]);
  if (view === 'columns' && folder !== null) scrollToItem(folderKey(folder));
}

export function historyGo(delta: number) {
  const { history, historyIndex } = getBrowser();
  const index = historyIndex + delta;
  const path = history[index];
  if (!path) return;
  exitResults();
  useBrowser.setState({ historyIndex: index });
  setSelection(cleared(getSelection(), columnAt(path.length - 1)));
  setPath(path, { fromHistory: true });
}

export function goUp() {
  const state = getBrowser();
  if (isResults(state)) {
    exitResults();
    return;
  }
  const { path, view } = state;
  if (path.length < 2) return;
  const parent = path[path.length - 2] ?? null;
  if (view === 'columns' && parent !== null)
    setSelection(only(folderKey(parent), path.length - 3));
  else setSelection(cleared(getSelection(), columnAt(path.length - 2)));
  setPath(path.slice(0, -1));
}

/** Opens a folder: in the column view, steps into its column when it is already open. */
export function enterFolder(queryClient: QueryClient, folder: EntityID) {
  const state = getBrowser();
  const { cursor } = getSelection();
  if (
    state.view === 'columns' &&
    !isResults(state) &&
    typeof cursor.col === 'number' &&
    cursor.key === folderKey(folder) &&
    state.path[cursor.col + 1] === folder
  ) {
    focusColumn(queryClient, cursor.col + 1);
    return;
  }
  goTo(queryClient, folder);
}

/** Selects the first item of column `index`, now or once it is listed. */
export function focusColumn(queryClient: QueryClient, index: number) {
  const { path } = getBrowser();
  if (index >= path.length) return;
  const [first] = columnOrder(queryClient, index);
  if (first) {
    selectOnly(first, index);
    return;
  }
  const listed = readListing(queryClient, folderSource(path[index] ?? null));
  useBrowser.setState({ pendingFocus: listed ? null : index });
}

/** Shows where a result lives: its folder, with it selected once listed. */
export function showInFolder(queryClient: QueryClient, key: ItemKey) {
  const item = findItem(queryClient, key);
  if (!item) return;
  const parent = itemParent(item);
  if (parent === null && item.kind === 'file') return;
  useBrowser.setState({ reveal: key });
  goTo(queryClient, parent);
}

// ---- Keyboard movement -------------------------------------------------------

export function moveCursor(
  queryClient: QueryClient,
  delta: number,
  extend: boolean
) {
  const col = viewColumn();
  const next = stepSelect(
    getSelection(),
    col,
    columnOrder(queryClient, col),
    delta,
    extend
  );
  select(next);
  if (next.cursor.key) scrollToItem(next.cursor.key);
}

/** Tiles in the grid's first row: up and down move by that many. */
export function gridPerRow(root: HTMLElement | null): number {
  const cells = root?.querySelector('[data-grid-cells]');
  if (!cells) return 1;
  const tiles = [...cells.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.item !== undefined
  );
  const [first] = tiles;
  if (!first) return 1;
  let count = 0;
  for (const tile of tiles) {
    if (tile.offsetTop !== first.offsetTop) break;
    count += 1;
  }
  return Math.max(1, count);
}

function moveInto(queryClient: QueryClient) {
  const { cursor, keys } = getSelection();
  if (typeof cursor.col !== 'number') return;
  const { path } = getBrowser();
  if (!cursor.key || !keys.has(cursor.key) || !isFolderKey(cursor.key)) {
    if (!cursor.key && path.length > cursor.col + 1)
      focusColumn(queryClient, cursor.col + 1);
    return;
  }
  focusColumn(queryClient, cursor.col + 1);
}

function moveOut() {
  const { cursor } = getSelection();
  if (typeof cursor.col !== 'number' || cursor.col < 1) return;
  const parent = getBrowser().path[cursor.col];
  if (!parent) return;
  useBrowser.setState({ pendingFocus: null });
  selectOnly(folderKey(parent), cursor.col - 1);
}

function parentRow(queryClient: QueryClient, key: ItemKey) {
  const item = findItem(queryClient, key);
  const parent = item ? itemParent(item) : null;
  if (parent !== null && parent !== currentFolder(getBrowser().path))
    selectOnly(folderKey(parent), 'list');
}

/** Opens or closes a folder of the list view in place. */
export function toggleExpand(
  queryClient: QueryClient,
  folder: EntityID,
  force?: boolean
) {
  const { expanded } = getBrowser();
  const open = force ?? !expanded.has(folder);
  if (open === expanded.has(folder)) return;
  const next = new Set(expanded);
  if (open) next.add(folder);
  else next.delete(folder);
  useBrowser.setState({ expanded: next });
  // What a closed folder hid cannot stay selected.
  if (!open) {
    const visible = new Set(listRows(queryClient));
    setSelection(keepHeld(getSelection(), (key) => visible.has(key)));
  }
}

function listExpand(queryClient: QueryClient, open: boolean) {
  const { key } = getSelection().cursor;
  if (!key) {
    moveCursor(queryClient, 1, false);
    return;
  }
  if (!isFolderKey(key)) {
    if (!open) parentRow(queryClient, key);
    return;
  }
  const folder = idOfKey(key);
  const isOpen = getBrowser().expanded.has(folder);
  if (open && !isOpen) toggleExpand(queryClient, folder, true);
  else if (open) {
    const rows = listRows(queryClient);
    const next = rows[rows.indexOf(key) + 1];
    if (next) selectOnly(next, 'list');
  } else if (isOpen) toggleExpand(queryClient, folder, false);
  else parentRow(queryClient, key);
}

/**
 * An arrow key, as the view reads it. Right to left, ArrowLeft goes forward:
 * deeper in the columns, the next tile in the grid, open in the list.
 */
export function arrow(
  queryClient: QueryClient,
  key: string,
  root: HTMLElement | null
) {
  const state = getBrowser();
  const view: View | 'results' = isResults(state) ? 'results' : state.view;
  const down = key === 'ArrowDown';
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step =
      view === 'grid' || (view === 'results' && state.view === 'grid')
        ? gridPerRow(root)
        : 1;
    moveCursor(queryClient, down ? step : -step, false);
    return;
  }
  const forward = key === 'ArrowLeft';
  if (view === 'columns') {
    if (forward) moveInto(queryClient);
    else moveOut();
  } else if (view === 'grid' || state.view === 'grid')
    moveCursor(queryClient, forward ? 1 : -1, false);
  else if (view === 'list') listExpand(queryClient, forward);
}

const typed = { text: '', at: 0 };
const TYPE_AHEAD_PAUSE_MS = 800;

/** Jumps to the first item whose name starts with what was just typed. */
export function typeAhead(queryClient: QueryClient, character: string) {
  const now = Date.now();
  typed.text =
    (now - typed.at > TYPE_AHEAD_PAUSE_MS ? '' : typed.text) +
    character.toLowerCase();
  typed.at = now;
  const col = viewColumn();
  const hit = columnOrder(queryClient, col).find((key) => {
    const item = findItem(queryClient, key);
    return item && itemName(item).toLowerCase().startsWith(typed.text);
  });
  if (hit) selectOnly(hit, col);
}

export function selectAll(queryClient: QueryClient) {
  const col = viewColumn();
  select(selectEvery(getSelection(), col, columnOrder(queryClient, col)));
}

// ---- View, sort, filters and search -----------------------------------------

export function setView(view: View) {
  const state = getBrowser();
  if (state.view === view) return;
  storeView(view);
  useBrowser.setState({ view, editing: null, pendingFocus: null });
  setSelection(cleared(getSelection(), lastColumn()));
}

export function setSort(id: SortId, desc?: boolean) {
  const { sort } = getBrowser();
  useBrowser.setState({
    sort: { id, desc: desc ?? (sort.id === id ? !sort.desc : false) },
  });
}

export function setMode(mode: Mode) {
  const state = getBrowser();
  if (state.mode === mode) return;
  useBrowser.setState({
    mode,
    queryFolder: mode === 'folders' ? state.queryFolder : null,
    editing: null,
    pendingFocus: null,
  });
  setSelection(cleared(getSelection(), lastColumn()));
}

/**
 * A filter chosen at the root, which holds folders only, would match nothing
 * there: the library switches to every file instead, and says so.
 */
export function setFilters(filters: LibraryFilters) {
  const state = getBrowser();
  useBrowser.setState({ filters });
  // What the filters now hide must not stay selected for a cut or a delete.
  setSelection(cleared(getSelection()));
  if (
    filterCount(filters) > 0 &&
    !isResults(state) &&
    currentFolder(state.path) === null
  ) {
    setMode('all');
    toast.info(MSG_FILTER_SWITCHED_TO_ALL);
  }
}

/** The folder a search started now is limited to, when the user is in one and chose it. */
function searchFolder(): EntityID | null {
  const state = getBrowser();
  const folder = currentFolder(state.path);
  return state.mode === 'folders' && state.searchScope === 'folder'
    ? folder
    : null;
}

/** Applies `text` as the search; a term the server would ignore clears it. */
export function setQuery(text: string) {
  const query = effectiveSearchTerm(text);
  const queryFolder = query ? searchFolder() : null;
  const state = getBrowser();
  if (query === state.query && queryFolder === state.queryFolder) return;
  const wasResults = isResults(state);
  useBrowser.setState({ query, queryFolder });
  if (!wasResults && !isResults(getBrowser())) return;
  useBrowser.setState({ pendingFocus: null, editing: null });
  setSelection(cleared(getSelection(), lastColumn()));
}

export function clearSearch() {
  useBrowser.setState({ searchText: '' });
  setQuery('');
}

export function setSearchScope(scope: SearchScope) {
  useBrowser.setState({ searchScope: scope });
  const { query } = getBrowser();
  if (query) setQuery(query);
}

/** Esc's last step: out of a search, then out of the flat list. */
export function leaveResults() {
  const state = getBrowser();
  if (state.query) clearSearch();
  else if (state.mode !== 'folders') setMode('folders');
}
