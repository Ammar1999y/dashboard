import type { CellRef, Level, Levels, Verb } from './matrix';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { ActorPermissions } from '@app/shared/permissions/scope';

import { createContext, useContext } from 'react';

import { toast } from 'sonner';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { MSG_CANNOT_EDIT_OWN_ROLE } from '@app/shared/messages/permissions';
import {
  MSG_PERM_COLUMN_UNCHANGED,
  MSG_PERM_NOTHING_TO_CHANGE,
  MSG_PERM_STUCK,
  MSG_PERM_UNDO,
  MSG_PERM_UNDONE,
} from '@/constants/messages';

import {
  actionLabelAt,
  applyColumn,
  applyRow,
  cellDef,
  cellKey,
  changedCells,
  columnState,
  cycleLevel,
  levelOf,
  rowState,
  setCell,
} from './matrix';
import { cellAt } from './navigation';

const HISTORY_MAX = 60;
const UNDO_TOAST_MS = 6000;
const SUMMARY_STORAGE_KEY = 'permission-matrix-summary';

/** A focusable place in the grid: row 0 is the header, column 0 the page. */
export interface NavPosition {
  row: number;
  col: number;
}

interface HistoryEntry {
  id: number;
  levels: Levels;
}

interface MatrixActions {
  step: (page: DashboardPage, verb: Verb, direction: 1 | -1) => void;
  setLevel: (page: DashboardPage, verb: Verb, level: Level) => void;
  toggleRow: (page: DashboardPage) => void;
  toggleColumn: (verb: Verb) => void;
  applyColumn: (verb: Verb, level: Level) => void;
  undo: () => void;
  setHover: (cell: CellRef | null) => void;
  setFocus: (cell: CellRef | null, position: NavPosition) => void;
  blur: () => void;
  setMenu: (menu: string | null) => void;
  /** Moves the tab stop off a place the stacked layout hides. */
  showTabStop: () => void;
  setHelp: (open: boolean) => void;
  setSummary: (on: boolean) => void;
  setAccess: (grants: ActorPermissions, readOnly: boolean) => void;
  /** Withdraws the undo toasts, whose actions would reach a store gone. */
  dispose: () => void;
}

export interface MatrixState {
  levels: Levels;
  /** What the signed-in user holds, and so may grant. */
  grants: ActorPermissions;
  readOnly: boolean;
  summary: boolean;
  hover: CellRef | null;
  focus: CellRef | null;
  /** The grid's one tab stop. */
  tabStop: NavPosition;
  /** The open menu: a cell key, or `column:<verb>`. */
  menu: string | null;
  help: boolean;
  /** A token per cell changed by something other than the user's own click. */
  pulses: Readonly<Record<string, number>>;
  history: readonly HistoryEntry[];
  actions: MatrixActions;
}

function storedSummary(): boolean {
  try {
    return localStorage.getItem(SUMMARY_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function storeSummary(on: boolean) {
  try {
    localStorage.setItem(SUMMARY_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Storage off or full: the switch still holds until a reload.
  }
}

const undoToastId = (id: number) => `permission-matrix-undo-${id}`;
const sameCell = (a: CellRef | null, b: CellRef | null) =>
  a?.page === b?.page && a?.verb === b?.verb;

export const columnMenu = (verb: Verb) => `column:${verb}`;

/** One store per mounted matrix, so no form starts from another form's grants. */
export const createMatrixStore = (initial: {
  levels: Levels;
  grants: ActorPermissions;
  readOnly: boolean;
}) =>
  createStore<MatrixState>()((set, get) => {
    let sequence = 0;
    let pulseToken = 0;

    const deny = (reason: string) => toast.error(reason);

    const undoTo = (id: number) => {
      const { history, levels, pulses } = get();
      const index = history.findIndex((entry) => entry.id === id);
      const entry = history[index];
      if (!entry) return;
      for (const undone of history.slice(index))
        toast.dismiss(undoToastId(undone.id));
      const nextPulses = { ...pulses };
      for (const cell of changedCells(levels, entry.levels))
        nextPulses[cellKey(cell)] = ++pulseToken;
      set({
        levels: entry.levels,
        history: history.slice(0, index),
        pulses: nextPulses,
      });
      toast.success(MSG_PERM_UNDONE);
    };

    /** `origin` is the cell the user acted on; every other change pulses. */
    const commit = (next: Levels, notes: string[], origin: CellRef | null) => {
      const { levels, history, pulses } = get();
      const id = ++sequence;
      const changed = changedCells(levels, next).filter(
        (cell) => !sameCell(cell, origin)
      );
      const nextPulses = { ...pulses };
      for (const cell of changed) nextPulses[cellKey(cell)] = ++pulseToken;
      set({
        levels: next,
        history: [...history, { id, levels }].slice(-HISTORY_MAX),
        pulses: nextPulses,
      });
      if (notes.length > 0) {
        toast.info(notes.join('\n'), {
          id: undoToastId(id),
          duration: UNDO_TOAST_MS,
          action: { label: MSG_PERM_UNDO, onClick: () => undoTo(id) },
        });
      }
    };

    /** Refuses every edit of a read-only matrix, and says why. */
    const editable = () => {
      if (!get().readOnly) return true;
      deny(MSG_CANNOT_EDIT_OWN_ROLE);
      return false;
    };

    const setLevel = (page: DashboardPage, verb: Verb, level: Level) => {
      if (!editable()) return;
      const { levels, grants } = get();
      const result = setCell(levels, page, verb, level, grants);
      if (!result.ok) {
        if (result.reason) deny(result.reason);
        return;
      }
      if (result.changed) commit(result.levels, result.notes, { page, verb });
    };

    return {
      levels: initial.levels,
      grants: initial.grants,
      readOnly: initial.readOnly,
      summary: storedSummary(),
      hover: null,
      focus: null,
      tabStop: { row: 1, col: 1 },
      menu: null,
      help: false,
      pulses: {},
      history: [],
      actions: {
        step: (page, verb, direction) => {
          if (!editable()) return;
          const def = cellDef(page, verb);
          if (!def) return;
          const { levels, grants } = get();
          const next = cycleLevel(
            def,
            levelOf(levels, page, verb),
            direction,
            grants
          );
          if (next === null) deny(MSG_PERM_STUCK(actionLabelAt(page, verb, 2)));
          else setLevel(page, verb, next);
        },
        setLevel,
        toggleRow: (page) => {
          if (!editable()) return;
          const { levels, grants } = get();
          const mode =
            rowState(levels, page, grants) === 'all' ? 'clear' : 'grant';
          const result = applyRow(levels, page, mode, grants);
          if (result.changed) commit(result.levels, result.notes, null);
          else deny(MSG_PERM_NOTHING_TO_CHANGE);
        },
        toggleColumn: (verb) => {
          const { levels, grants, actions } = get();
          actions.applyColumn(
            verb,
            columnState(levels, verb, grants) === 'all' ? 0 : 2
          );
        },
        applyColumn: (verb, level) => {
          if (!editable()) return;
          const { levels, grants } = get();
          const result = applyColumn(levels, verb, level, grants);
          if (result.changed) commit(result.levels, result.notes, null);
          else deny(result.notes[0] ?? MSG_PERM_COLUMN_UNCHANGED);
        },
        undo: () => {
          const { history } = get();
          const last = history[history.length - 1];
          if (last) undoTo(last.id);
        },
        setHover: (cell) => {
          if (!sameCell(get().hover, cell)) set({ hover: cell });
        },
        setFocus: (cell, position) => {
          const { focus, tabStop } = get();
          const moved =
            tabStop.row !== position.row || tabStop.col !== position.col;
          if (moved || !sameCell(focus, cell))
            set({ focus: cell, tabStop: moved ? position : tabStop });
        },
        blur: () => {
          if (get().focus) set({ focus: null });
        },
        setMenu: (menu) => {
          if (menu === null || editable()) set({ menu });
        },
        showTabStop: () => {
          const { row, col } = get().tabStop;
          const cell = cellAt(row, col);
          if (cell && !cellDef(cell.page, cell.verb))
            set({ tabStop: { row: 1, col: 1 } });
        },
        setHelp: (help) => set({ help }),
        setSummary: (summary) => {
          storeSummary(summary);
          set({ summary });
        },
        setAccess: (grants, readOnly) => {
          const current = get();
          if (current.grants !== grants || current.readOnly !== readOnly)
            set({ grants, readOnly });
        },
        dispose: () => {
          for (const entry of get().history)
            toast.dismiss(undoToastId(entry.id));
        },
      },
    };
  });

export type MatrixStore = ReturnType<typeof createMatrixStore>;

export const MatrixStoreContext = createContext<MatrixStore | null>(null);

export function useMatrixStoreApi(): MatrixStore {
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
