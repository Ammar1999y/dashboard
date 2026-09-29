import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingInfoState,
  ColumnSizingState,
  Updater,
  VisibilityState,
} from '@tanstack/react-table';

import { arrayMove } from '@dnd-kit/sortable';
import { functionalUpdate } from '@tanstack/react-table';
import { createStore } from 'zustand/vanilla';

import { loadLayout, saveLayout } from './layout-storage';

/** The per-table column state that is saved between visits. */
export interface ColumnLayout {
  columnOrder: ColumnOrderState;
  columnVisibility: VisibilityState;
  columnPinning: ColumnPinningState;
  columnSizing: ColumnSizingState;
}

export type PinSide = 'left' | 'right';

/** `previous`/`next` step one place; `first`/`last` jump to the end of the column's pin zone. */
export type MoveTarget = 'previous' | 'next' | 'first' | 'last';

export interface ColumnActions {
  setColumnSizing: (updater: Updater<ColumnSizingState>) => void;
  setColumnSizingInfo: (updater: Updater<ColumnSizingInfoState>) => void;
  setVisible: (columnId: string, visible: boolean) => void;
  showAll: () => void;
  pin: (columnId: string, side: PinSide | false) => void;
  move: (columnId: string, target: MoveTarget) => void;
  /** A drag of `activeId` dropped on `overId`; dropping on a pinned column joins its zone. */
  drop: (activeId: string, overId: string) => void;
  resetSize: (columnId: string) => void;
  reset: () => void;
}

export interface ColumnStoreState extends ColumnLayout {
  columnSizingInfo: ColumnSizingInfoState;
  actions: ColumnActions;
}

export type ColumnStore = ReturnType<typeof createColumnStore>;

const IDLE_SIZING_INFO: ColumnSizingInfoState = {
  startOffset: null,
  startSize: null,
  deltaOffset: null,
  deltaPercentage: null,
  isResizingColumn: false,
  columnSizingStart: [],
};

const SAVE_DELAY_MS = 500;

/** Pinned columns first and last, the rest in their current relative order. */
function orderByPinning(order: string[], pinning: ColumnPinningState) {
  const left = pinning.left ?? [];
  const right = pinning.right ?? [];
  const pinned = new Set([...left, ...right]);
  return [...left, ...order.filter((id) => !pinned.has(id)), ...right];
}

/** The pin zone a column sits in, and that zone's columns in display order. */
function zoneOf(
  { columnOrder, columnPinning }: ColumnLayout,
  columnId: string
): { zone: PinSide | 'center'; segment: string[] } {
  const left = columnPinning.left ?? [];
  if (left.includes(columnId)) return { zone: 'left', segment: left };
  const right = columnPinning.right ?? [];
  if (right.includes(columnId)) return { zone: 'right', segment: right };
  const pinned = new Set([...left, ...right]);
  return {
    zone: 'center',
    segment: columnOrder.filter((id) => !pinned.has(id)),
  };
}

export const selectPinSide =
  (columnId: string) =>
  (state: ColumnLayout): PinSide | false => {
    const { zone } = zoneOf(state, columnId);
    return zone === 'center' ? false : zone;
  };

/** Whether the column can still move towards the start / end of its zone. */
export const selectCanMove =
  (columnId: string, direction: 'previous' | 'next') =>
  (state: ColumnLayout): boolean => {
    const { segment } = zoneOf(state, columnId);
    const index = segment.indexOf(columnId);
    return direction === 'previous'
      ? index > 0
      : index !== -1 && index < segment.length - 1;
  };

// Key order can differ between equal layouts; a false "different" only saves
// a layout that happens to equal the defaults, which is harmless.
const isSameLayout = (a: ColumnLayout, b: ColumnLayout) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * One store per mounted table. Created with the defaults as its initial state
 * and the saved layout applied on top, so a server render and the hydration
 * pass see the defaults (zustand's server snapshot is the initial state) while
 * a client render starts on the saved layout — never a frame of the other.
 */
export function createColumnStore(
  storageKey: string,
  columnIds: string[],
  defaults: ColumnLayout
) {
  const store = createStore<ColumnStoreState>()((set, get) => ({
    ...defaults,
    columnSizingInfo: IDLE_SIZING_INFO,
    actions: {
      setColumnSizing: (updater) =>
        set((s) => ({
          columnSizing: functionalUpdate(updater, s.columnSizing),
        })),
      setColumnSizingInfo: (updater) =>
        set((s) => ({
          columnSizingInfo: functionalUpdate(updater, s.columnSizingInfo),
        })),
      setVisible: (columnId, visible) =>
        set((s) => ({
          columnVisibility: { ...s.columnVisibility, [columnId]: visible },
        })),
      showAll: () => set({ columnVisibility: {} }),
      pin: (columnId, side) => {
        const { columnPinning, columnOrder } = get();
        const left = (columnPinning.left ?? []).filter((id) => id !== columnId);
        const right = (columnPinning.right ?? []).filter(
          (id) => id !== columnId
        );
        if (side === 'left') left.push(columnId);
        else if (side === 'right') right.push(columnId);
        const nextPinning = { left, right };
        set({
          columnPinning: nextPinning,
          columnOrder: orderByPinning(columnOrder, nextPinning),
        });
      },
      move: (columnId, target) => {
        const state = get();
        const { columnPinning, columnOrder } = state;
        const left = columnPinning.left ?? [];
        const right = columnPinning.right ?? [];
        const { zone, segment } = zoneOf(state, columnId);

        const from = segment.indexOf(columnId);
        const to =
          target === 'first'
            ? 0
            : target === 'last'
              ? segment.length - 1
              : from + (target === 'previous' ? -1 : 1);
        if (to === from || from === -1 || to < 0 || to >= segment.length)
          return;

        const moved = arrayMove(segment, from, to);
        const nextPinning = {
          left: zone === 'left' ? moved : left,
          right: zone === 'right' ? moved : right,
        };
        set({
          columnPinning: nextPinning,
          columnOrder:
            zone === 'center'
              ? [...left, ...moved, ...right]
              : orderByPinning(columnOrder, nextPinning),
        });
      },
      drop: (activeId, overId) => {
        if (activeId === overId) return;
        const { columnPinning, columnOrder } = get();
        const from = columnOrder.indexOf(activeId);
        const to = columnOrder.indexOf(overId);
        if (from === -1 || to === -1) return;

        const left = new Set(columnPinning.left);
        const right = new Set(columnPinning.right);
        const joinsLeft = left.has(overId);
        const joinsRight = right.has(overId);
        left.delete(activeId);
        right.delete(activeId);
        if (joinsLeft) left.add(activeId);
        else if (joinsRight) right.add(activeId);

        const nextOrder = arrayMove(columnOrder, from, to);
        set({
          columnOrder: nextOrder,
          columnPinning: {
            left: nextOrder.filter((id) => left.has(id)),
            right: nextOrder.filter((id) => right.has(id)),
          },
        });
      },
      resetSize: (columnId) =>
        set((s) => {
          const { [columnId]: _, ...columnSizing } = s.columnSizing;
          return { columnSizing };
        }),
      reset: () => set({ ...defaults }),
    },
  }));

  if (typeof window !== 'undefined') {
    const saved = loadLayout(storageKey, columnIds);
    if (saved) store.setState(saved);
  }
  return store;
}

const layoutOf = ({
  columnOrder,
  columnVisibility,
  columnPinning,
  columnSizing,
}: ColumnLayout): ColumnLayout => ({
  columnOrder,
  columnVisibility,
  columnPinning,
  columnSizing,
});

/**
 * Saves layout changes, debounced, and flushes the pending one on teardown.
 * A layout equal to the defaults removes the saved entry, so a later change
 * to a table's defaults reaches everyone who never customised it.
 */
export function persistColumnStore(
  store: ColumnStore,
  storageKey: string,
  defaults: ColumnLayout
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ColumnLayout | null = null;

  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    saveLayout(storageKey, isSameLayout(pending, defaults) ? null : pending);
    pending = null;
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.columnOrder === previous.columnOrder &&
      state.columnVisibility === previous.columnVisibility &&
      state.columnPinning === previous.columnPinning &&
      state.columnSizing === previous.columnSizing
    )
      return;
    pending = layoutOf(state);
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  addEventListener('pagehide', flush);

  return () => {
    unsubscribe();
    removeEventListener('pagehide', flush);
    flush();
  };
}
