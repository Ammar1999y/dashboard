import type { PagePermission } from '@/types/permission';
import type { PermissionAction } from '@app/shared/permissions/constants';

import {
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTION_NAMES,
} from '@app/shared/permissions/constants';

/**
 * One row per page of `PAGES` and one column per action of `ACTIONS`, both in
 * catalog order. A cell the page does not offer is always `false`.
 */
export type Matrix = readonly (readonly boolean[])[];

export const PAGES = DEFAULT_PAGE_PERMISSIONS;
export const ACTIONS = PERMISSION_ACTION_NAMES;

/**
 * Write actions and the read actions any one of which they need. Mirrors the
 * refinement on `pagePermissionSchema` in `@app/shared/validation/permissions`:
 * a matrix the UI accepts must be one the server accepts.
 */
const GATES: Partial<Record<PermissionAction, readonly PermissionAction[]>> = {
  edit: ['view'],
  delete: ['view'],
  publish: ['view'],
  editOwn: ['view', 'viewOwn'],
  deleteOwn: ['view', 'viewOwn'],
};

const GATE_COLUMNS = ACTIONS.map((action) =>
  (GATES[action] ?? []).map((gate) => ACTIONS.indexOf(gate))
);

export const offers = (row: number, col: number): boolean =>
  PAGES[row]?.availablePermissions.includes(ACTIONS[col]) ?? false;

/** A write cell whose every read prerequisite is off. */
export const isGatedOff = (cells: readonly boolean[], col: number): boolean => {
  const gates = GATE_COLUMNS[col] ?? [];
  return gates.length > 0 && !gates.some((gate) => cells[gate]);
};

/** Turns off every cell the page does not offer or whose gate is closed. */
const sanitizeRow = (row: number, cells: readonly boolean[]): boolean[] => {
  const offered = cells.map((checked, col) => checked && offers(row, col));
  return offered.map((checked, col) => checked && !isGatedOff(offered, col));
};

/** The matrix of `pages`, matched by name: a page it leaves out is all off. */
export function toMatrix(pages: readonly PagePermission[]): Matrix {
  return PAGES.map((page, row) => {
    const granted = pages.find((p) => p.name === page.name)?.permissions;
    return sanitizeRow(
      row,
      ACTIONS.map((action) => granted?.[action] === true)
    );
  });
}

/** Every page, each with exactly the actions it offers. */
export function fromMatrix(matrix: Matrix): PagePermission[] {
  return PAGES.map((page, row) => ({
    name: page.name,
    permissions: Object.fromEntries(
      page.availablePermissions.map((action) => [
        action,
        matrix[row]?.[ACTIONS.indexOf(action)] ?? false,
      ])
    ),
  }));
}

/** What a new role or a new custom user starts from. */
export const FULL_ACCESS: Matrix = PAGES.map((_, row) =>
  ACTIONS.map((_action, col) => offers(row, col))
);

/** The matrix a form starts from: its stored pages, or full access when it has none. */
export const initialMatrix = (pages: readonly PagePermission[] | undefined) =>
  pages?.length ? toMatrix(pages) : FULL_ACCESS;

/** Whether two page lists grant the same, whatever their order or omitted `false`s. */
export const samePermissions = (
  a: readonly PagePermission[] | undefined,
  b: readonly PagePermission[] | undefined
): boolean =>
  JSON.stringify(fromMatrix(toMatrix(a ?? []))) ===
  JSON.stringify(fromMatrix(toMatrix(b ?? [])));

const replaceRow = (matrix: Matrix, row: number, cells: boolean[]): Matrix =>
  matrix.map((current, index) => (index === row ? cells : current));

export function setCell(
  matrix: Matrix,
  row: number,
  col: number,
  checked: boolean
): Matrix {
  const cells = matrix[row];
  if (!cells || !offers(row, col)) return matrix;
  if (checked && isGatedOff(cells, col)) return matrix;
  const next = [...cells];
  next[col] = checked;
  // Unchecking a read action closes the writes it was the last gate of.
  return replaceRow(matrix, row, sanitizeRow(row, next));
}

/** Checks the column on every page that can take it, or clears it if all already are. */
export function toggleColumn(matrix: Matrix, col: number): Matrix {
  const eligible = matrix.map(
    (cells, row) => offers(row, col) && !isGatedOff(cells, col)
  );
  const checked = matrix.some((cells, row) => eligible[row] && !cells[col]);
  return matrix.map((cells, row) => {
    if (!eligible[row]) return cells;
    const next = [...cells];
    next[col] = checked;
    return sanitizeRow(row, next);
  });
}

/** Checks every action the page offers, or clears them if all already are. */
export function toggleRow(matrix: Matrix, row: number): Matrix {
  const cells = matrix[row];
  if (!cells) return matrix;
  const checked = cells.some((value, col) => offers(row, col) && !value);
  return replaceRow(
    matrix,
    row,
    cells.map((_, col) => checked && offers(row, col))
  );
}
