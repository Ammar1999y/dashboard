import type { CellRef } from './matrix';

import { PAGES, VERBS } from './matrix';

/**
 * The grid's focusable places, by `data-row` (0 the header, then one per page)
 * and `data-col` (0 the page, then one per verb). Moving reads the DOM rather
 * than a model so it follows what is rendered: a stacked layout hides the
 * cells a page does not offer, and they are skipped.
 */
const ROWS = PAGES.length + 1;
const COLS = VERBS.length + 1;

export interface NavTarget {
  row: number;
  col: number;
  element: HTMLElement;
}

export function navTarget(
  grid: HTMLElement,
  target: EventTarget | null
): NavTarget | null {
  if (!(target instanceof HTMLElement) || !grid.contains(target)) return null;
  const element = target.closest<HTMLElement>('[data-nav]');
  if (!element || !grid.contains(element)) return null;
  return {
    row: Number(element.dataset.row),
    col: Number(element.dataset.col),
    element,
  };
}

/** The cell a body position holds, whether the page offers it or not. */
export function cellAt(row: number, col: number): CellRef | null {
  const page = PAGES[row - 1];
  const verb = VERBS[col - 1];
  return page && verb ? { page, verb } : null;
}

const isStacked = (grid: HTMLElement) =>
  grid.closest<HTMLElement>('[data-stacked]')?.dataset.stacked === 'true';

function focusable(grid: HTMLElement, row: number, col: number) {
  const element = grid.querySelector<HTMLElement>(
    `[data-nav][data-row="${CSS.escape(String(row))}"][data-col="${CSS.escape(String(col))}"]`
  );
  if (!element) return null;
  return isStacked(grid) && element.dataset.notOffered !== undefined
    ? null
    : element;
}

/** Steps from `from` until a focusable place, and focuses it; stays at an edge. */
export function moveFocus(
  grid: HTMLElement,
  from: NavTarget,
  rows: number,
  cols: number
) {
  let row = from.row + rows;
  let col = from.col + cols;
  while (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
    const element = focusable(grid, row, col);
    if (element) {
      element.focus();
      return;
    }
    row += rows;
    col += cols;
  }
}

/** Focuses the first or last focusable place of `from`'s row. */
export function edgeFocus(grid: HTMLElement, from: NavTarget, last: boolean) {
  const cols = Array.from({ length: COLS }, (_, col) => col);
  if (last) cols.reverse();
  for (const col of cols) {
    const element = focusable(grid, from.row, col);
    if (element) {
      element.focus();
      return;
    }
  }
}

/** Columns run right to left under `dir='rtl'`, so the arrows swap. */
export const inlineStep = (grid: HTMLElement, key: string) => {
  const forward = getComputedStyle(grid).direction === 'rtl' ? -1 : 1;
  return key === 'ArrowRight' ? forward : -forward;
};
