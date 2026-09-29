import type { Matrix } from './matrix';

import { createContext, useContext } from 'react';

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { setCell, toggleColumn, toggleRow } from './matrix';

interface MatrixActions {
  setCell: (row: number, col: number, checked: boolean) => void;
  toggleColumn: (col: number) => void;
  toggleRow: (row: number) => void;
}

interface MatrixState {
  matrix: Matrix;
  actions: MatrixActions;
}

/** One store per mounted matrix, so no page starts from another page's grants. */
export const createMatrixStore = (initial: Matrix) =>
  createStore<MatrixState>()((set) => ({
    matrix: initial,
    actions: {
      setCell: (row, col, checked) =>
        set((s) => ({ matrix: setCell(s.matrix, row, col, checked) })),
      toggleColumn: (col) =>
        set((s) => ({ matrix: toggleColumn(s.matrix, col) })),
      toggleRow: (row) => set((s) => ({ matrix: toggleRow(s.matrix, row) })),
    },
  }));

export type MatrixStore = ReturnType<typeof createMatrixStore>;

export const MatrixStoreContext = createContext<MatrixStore | null>(null);

function useMatrixStoreApi(): MatrixStore {
  const store = useContext(MatrixStoreContext);
  if (!store)
    throw new Error('Matrix hooks must be used inside a PermissionMatrix');
  return store;
}

/** Subscribes to one slice of the matrix; select the smallest slice. */
export const useMatrix = <T>(selector: (state: MatrixState) => T): T =>
  useStore(useMatrixStoreApi(), selector);

/** The actions object never changes, so reading it needs no subscription. */
export const useMatrixActions = (): MatrixActions =>
  useMatrixStoreApi().getState().actions;
