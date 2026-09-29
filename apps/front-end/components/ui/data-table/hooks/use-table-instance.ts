import type { PinSide } from '../store/column-store';
import type {
  Cell,
  Column,
  ColumnDef,
  Header,
  HeaderGroup,
  Row,
  Table,
} from '@tanstack/react-table';

import { useMemo } from 'react';

import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useShallow } from 'zustand/shallow';

import { renderDefaultHeader } from '../column-header';
import { useColumnActions, useColumnStore } from '../store/context';

interface PinPlacement {
  side: PinSide;
  /** The innermost pinned column of its side, which draws the edge shadow. */
  edge: boolean;
}

/**
 * The visible columns in display order. Rebuilt only when visibility, order or
 * pinning change — never on a resize or new data — so it is the dependency
 * that tells the header its structure changed.
 */
export interface TableLayout<TData> {
  headers: Header<TData, unknown>[];
  columnIds: string[];
  pins: Partial<Record<string, PinPlacement>>;
}

export interface ColumnRule {
  id: string;
  size: number;
  hidden: boolean;
  /** Set while the column is pinned and visible. */
  pinOffset: number | undefined;
}

export interface BodyRow<TData> {
  row: Row<TData>;
  cells: Cell<TData, unknown>[];
}

// Module-level on purpose: `getCoreRowModel()` inline returns a new function
// each render, which TanStack treats as a new option and rebuilds rows for.
const coreRowModel = getCoreRowModel();

const DEFAULT_COLUMN = {
  minSize: 170,
  maxSize: 800,
  enableColumnFilter: false,
  header: renderDefaultHeader,
};

// Rows are keyed by record id, not by index: a sort or a new page then
// moves or replaces a record's row instead of rewriting another record's DOM,
// and the row/cell memo comparators in `body.tsx` stay per record.
function getRowId<TData>(original: TData, index: number): string {
  const id: unknown = (original as { id?: unknown } | null)?.id;
  return String(typeof id === 'string' || typeof id === 'number' ? id : index);
}

function placementOf<TData>(column: Column<TData>): PinPlacement | undefined {
  const side = column.getIsPinned();
  if (!side) return undefined;
  return {
    side,
    edge:
      side === 'left'
        ? column.getIsLastColumn('left')
        : column.getIsFirstColumn('right'),
  };
}

function buildLayout<TData>(
  headerGroups: HeaderGroup<TData>[]
): TableLayout<TData> {
  const headers = headerGroups[headerGroups.length - 1]?.headers ?? [];
  const pins: TableLayout<TData>['pins'] = {};
  for (const { column } of headers) pins[column.id] = placementOf(column);
  return { headers, columnIds: headers.map((h) => h.column.id), pins };
}

function buildColumnRules<TData>(
  table: Table<TData>,
  layout: TableLayout<TData>
): ColumnRule[] {
  // Definition order, never display order (`getAllLeafColumns`): reordering
  // `<style>` elements makes the browser restyle every element.
  const leaves = table
    .getAllFlatColumns()
    .filter((c) => c.columns.length === 0);
  return leaves.map((column) => {
    const side = layout.pins[column.id]?.side;
    return {
      id: column.id,
      size: column.getSize(),
      hidden: !column.getIsVisible(),
      pinOffset:
        side === undefined
          ? undefined
          : side === 'left'
            ? column.getStart('left')
            : column.getAfter('right'),
    };
  });
}

/**
 * The one owner of the TanStack instance. `table` keeps its identity for the
 * table's lifetime, so a component that renders from it is cached forever by
 * React Compiler; render from the values returned here, whose identities
 * change exactly when what they describe does. `table` is for event handlers.
 */
export function useTableInstance<TData>(
  columns: ColumnDef<TData>[],
  data: TData[]
) {
  const actions = useColumnActions();
  const state = useColumnStore(
    useShallow((s) => ({
      columnOrder: s.columnOrder,
      columnVisibility: s.columnVisibility,
      columnPinning: s.columnPinning,
      columnSizing: s.columnSizing,
      columnSizingInfo: s.columnSizingInfo,
    }))
  );

  // The one suppression in this area, and it is meant: the compiler skips this
  // hook either way, and everything below is memoized by hand. Never move a
  // TanStack call that renders into a component instead — that is how the
  // header and rows used to freeze.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable<TData>({
    data,
    columns,
    state,
    onColumnSizingChange: actions.setColumnSizing,
    onColumnSizingInfoChange: actions.setColumnSizingInfo,
    getCoreRowModel: coreRowModel,
    getRowId,
    defaultColumn: DEFAULT_COLUMN,
    // Rows arrive already searched, sorted and paged — by the server, or by
    // `queryRows` for a client-side list; TanStack only lays out columns.
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    columnResizeDirection: 'rtl',
    enableColumnPinning: true,
  });

  const headerGroups = table.getHeaderGroups();
  const layout = useMemo(() => buildLayout(headerGroups), [headerGroups]);

  const { rows } = table.getRowModel();
  // Every column's cell, hidden ones too (`ColumnRules` hides them): a hide or
  // show then inserts or removes no DOM node, which in this app would restyle
  // the rest of each row — the global `space-*` utilities are sibling
  // selectors. TanStack memoizes each zone, so these change only on a move or
  // pin, and they are the explicit reason this recomputes.
  const left = table.getLeftLeafColumns();
  const center = table.getCenterLeafColumns();
  const right = table.getRightLeafColumns();
  const bodyRows = useMemo<BodyRow<TData>[]>(() => {
    const columns = [...left, ...center, ...right];
    return rows.map((row) => {
      const cells = new Map(row.getAllCells().map((c) => [c.column.id, c]));
      return { row, cells: columns.flatMap((c) => cells.get(c.id) ?? []) };
    });
  }, [rows, left, center, right]);

  return {
    table,
    headerGroups,
    layout,
    bodyRows,
    // Not memoized on purpose: its inputs change on every resize step anyway,
    // and each rule reaches a memoized `<style>` that compares its numbers.
    columnRules: buildColumnRules(table, layout),
    tableWidth: table.getTotalSize(),
    allColumns: table.getAllColumns(),
  };
}
