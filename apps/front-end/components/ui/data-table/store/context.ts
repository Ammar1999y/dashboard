import type {
  ColumnActions,
  ColumnStore,
  ColumnStoreState,
} from './column-store';

import { createContext, useContext } from 'react';

import { useStore } from 'zustand';

export const ColumnStoreContext = createContext<ColumnStore | null>(null);

export function useColumnStoreApi(): ColumnStore {
  const store = useContext(ColumnStoreContext);
  if (!store)
    throw new Error('Column store hooks must be used inside a DataTable');
  return store;
}

/** Subscribes to one slice of the table's column state; select the smallest slice. */
export function useColumnStore<T>(selector: (state: ColumnStoreState) => T): T {
  return useStore(useColumnStoreApi(), selector);
}

/**
 * The table's column actions. Reading `getState()` during render is safe here
 * and deliberate: the actions object never changes, so there is nothing to
 * subscribe to, and callers do not re-render on column changes.
 */
export function useColumnActions(): ColumnActions {
  return useColumnStoreApi().getState().actions;
}
