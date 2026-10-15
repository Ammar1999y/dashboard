import type { ItemKey } from './keys';

import { create } from 'zustand';

/**
 * Where a selection was made: a column of the column view by its index, or
 * the one list another view shows. Ranges and arrow keys stay inside one.
 */
export type SelectionColumn = number | 'grid' | 'list' | 'results';

interface Cursor {
  key: ItemKey | null;
  col: SelectionColumn;
}

export interface Selection {
  keys: ReadonlySet<ItemKey>;
  cursor: Cursor;
  /** Where a shift-range starts. */
  anchor: ItemKey | null;
}

const NONE: ReadonlySet<ItemKey> = new Set();

export const EMPTY_SELECTION: Selection = {
  keys: NONE,
  cursor: { key: null, col: 0 },
  anchor: null,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** `order` from `from` to `to`, both included, whichever comes first. */
function between(order: readonly ItemKey[], from: number, to: number) {
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** Exactly `key`, which the cursor and the next range start from. */
export const only = (key: ItemKey, col: SelectionColumn): Selection => ({
  keys: new Set([key]),
  cursor: { key, col },
  anchor: key,
});

export interface ClickModifiers {
  /** Ctrl or ⌘: add or remove one. */
  toggle: boolean;
  /** Shift: the range from the anchor. */
  range: boolean;
}

/**
 * A click on `key` in `col`, whose items are `order`. A range or a toggle holds
 * inside the column the selection was made in; from another one, a click
 * starts over, except a toggle into an empty selection.
 */
export function clickSelect(
  current: Selection,
  key: ItemKey,
  col: SelectionColumn,
  order: readonly ItemKey[],
  { toggle, range }: ClickModifiers
): Selection {
  const sameColumn = current.cursor.col === col;
  if (range && sameColumn && current.anchor) {
    const from = order.indexOf(current.anchor);
    const to = order.indexOf(key);
    if (from !== -1 && to !== -1) {
      const span = between(order, from, to);
      return {
        keys: new Set(toggle ? [...current.keys, ...span] : span),
        cursor: { key, col },
        anchor: current.anchor,
      };
    }
  }
  if (toggle && (sameColumn || current.keys.size === 0)) {
    const keys = new Set(current.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, cursor: { key, col }, anchor: key };
  }
  return only(key, col);
}

/**
 * The cursor moved by `delta` through `order`, selecting where it lands, or,
 * with `extend`, the range from the anchor to there. From outside the list it
 * enters at the first item going forward and the last going back.
 */
export function stepSelect(
  current: Selection,
  col: SelectionColumn,
  order: readonly ItemKey[],
  delta: number,
  extend: boolean
): Selection {
  if (order.length === 0) return current;
  const at =
    current.cursor.col === col && current.cursor.key
      ? order.indexOf(current.cursor.key)
      : -1;
  let next: number;
  if (at === -1) next = delta > 0 ? 0 : order.length - 1;
  else next = clamp(at + delta, 0, order.length - 1);
  const key = order[next];
  if (key === undefined) return current;
  if (!extend) return only(key, col);
  const anchor =
    current.anchor && order.includes(current.anchor)
      ? current.anchor
      : order[Math.max(at, 0)];
  if (anchor === undefined) return only(key, col);
  return {
    keys: new Set(between(order, order.indexOf(anchor), next)),
    cursor: { key, col },
    anchor,
  };
}

/** Every item of the column; the cursor stays on its item when it is one. */
export function selectEvery(
  current: Selection,
  col: SelectionColumn,
  order: readonly ItemKey[]
): Selection {
  const [first] = order;
  if (first === undefined) return current;
  const cursorKey =
    current.cursor.key && order.includes(current.cursor.key)
      ? current.cursor.key
      : first;
  return {
    keys: new Set(order),
    cursor: { key: cursorKey, col },
    anchor: first,
  };
}

/** What is left once the items `held` no longer reports are dropped. */
export function keepHeld(
  current: Selection,
  held: (key: ItemKey) => boolean
): Selection {
  const kept = [...current.keys].filter(held);
  const cursorGone = current.cursor.key !== null && !held(current.cursor.key);
  const anchorGone = current.anchor !== null && !held(current.anchor);
  if (!cursorGone && !anchorGone && kept.length === current.keys.size)
    return current;
  return {
    keys: kept.length === current.keys.size ? current.keys : new Set(kept),
    cursor: cursorGone
      ? { key: null, col: current.cursor.col }
      : current.cursor,
    anchor: anchorGone ? null : current.anchor,
  };
}

/** Nothing selected; the cursor keeps its column, or moves to `col`. */
export const cleared = (
  current: Selection,
  col: SelectionColumn = current.cursor.col
): Selection => ({ keys: NONE, cursor: { key: null, col }, anchor: null });

/**
 * The library's one selection, of files and folders together, and its cursor.
 * Rows subscribe to their own key, so a change re-renders the rows it touches.
 */
export const useSelection = create<Selection>(() => EMPTY_SELECTION);

export const setSelection = (next: Selection) => {
  if (next !== useSelection.getState()) useSelection.setState(next, true);
};

export const getSelection = () => useSelection.getState();

export const useIsSelected = (key: ItemKey) =>
  useSelection((s) => s.keys.has(key));

export const useIsCursor = (key: ItemKey) =>
  useSelection((s) => s.cursor.key === key);
