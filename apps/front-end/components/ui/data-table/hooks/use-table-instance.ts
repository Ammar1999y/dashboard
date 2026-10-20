import type { DataTableFeatures } from '../features';
import type { PinSide } from '../store/column-store';
import type {
  Cell,
  Column,
  ColumnDef,
  Header,
  HeaderGroup,
  Row,
  RowData,
  Table,
} from '@tanstack/react-table';

import { useMemo } from 'react';

import { useTable } from '@tanstack/react-table';
import { useShallow } from 'zustand/shallow';

import { renderDefaultHeader } from '../column-header';
import { DATA_TABLE_FEATURES } from '../features';
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
export interface TableLayout<TData extends RowData> {
  headers: Header<DataTableFeatures, TData>[];
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

export interface BodyRow<TData extends RowData> {
  row: Row<DataTableFeatures, TData>;
  cells: Cell<DataTableFeatures, TData>[];
}

// Every slice this table renders from is controlled by the column store, which
// already re-renders the frame; subscribing `useTable` too would only repeat it.
const NO_TABLE_STATE = () => null;

const DEFAULT_COLUMN = {
  minSize: 170,
  maxSize: 800,
  enableColumnFilter: false,
  header: renderDefaultHeader,
};

// Rows are keyed by record id, not by index: a sort or a new page then
// moves or replaces a record's row instead of rewriting another record's DOM,
// and the row/cell memo comparators in `body.tsx` stay per record.
function getRowId<TData extends RowData>(original: TData, index: number) {
  const id: unknown = Array.isArray(original) ? undefined : original.id;
  return String(typeof id === 'string' || typeof id === 'number' ? id : index);
}

function placementOf<TData extends RowData>(
  column: Column<DataTableFeatures, TData>
): PinPlacement | undefined {
  const side = column.getIsPinned();
  if (!side) return undefined;
  return {
    side,
    edge:
      side === 'start'
        ? column.getIsLastColumn('start')
        : column.getIsFirstColumn('end'),
  };
}

function buildLayout<TData extends RowData>(
  headerGroups: HeaderGroup<DataTableFeatures, TData>[]
): TableLayout<TData> {
  const headers = headerGroups[headerGroups.length - 1]?.headers ?? [];
  const pins: TableLayout<TData>['pins'] = {};
  for (const { column } of headers) pins[column.id] = placementOf(column);
  return { headers, columnIds: headers.map((h) => h.column.id), pins };
}

function buildColumnRules<TData extends RowData>(
  table: Table<DataTableFeatures, TData>,
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
          : side === 'start'
            ? column.getStart('start')
            : column.getAfter('end'),
    };
  });
}

/**
 * The one owner of the TanStack instance. Its getters keep their results'
 * identities until what they describe changes, which is what the memos below
 * depend on; React Compiler cannot see a read hidden in a getter, so render
 * from the values returned here. `table` is for event handlers.
 */
export function useTableInstance<TData extends RowData>(
  columns: ColumnDef<DataTableFeatures, TData>[],
  data: TData[]
) {
  const actions = useColumnActions();
  const state = useColumnStore(
    useShallow((s) => ({
      columnOrder: s.columnOrder,
      columnVisibility: s.columnVisibility,
      columnPinning: s.columnPinning,
      columnSizing: s.columnSizing,
      columnResizing: s.columnResizing,
    }))
  );

  const table = useTable(
    {
      features: DATA_TABLE_FEATURES,
      data,
      columns,
      state,
      onColumnSizingChange: actions.setColumnSizing,
      onColumnResizingChange: actions.setColumnResizing,
      getRowId,
      defaultColumn: DEFAULT_COLUMN,
      // Rows arrive already searched, sorted and paged — by the server, or by
      // `queryRows` for a client-side list; TanStack only lays out columns.
      manualSorting: true,
      manualFiltering: true,
      enableColumnResizing: true,
      columnResizeMode: 'onChange',
      columnResizeDirection: 'rtl',
      enableColumnPinning: true,
    },
    NO_TABLE_STATE
  );

  const headerGroups = table.getHeaderGroups();
  const layout = useMemo(() => buildLayout(headerGroups), [headerGroups]);

  const { rows } = table.getRowModel();
  // Every column's cell, hidden ones too (`ColumnRules` hides them): a hide or
  // show then inserts or removes no DOM node, which in this app would restyle
  // the rest of each row — the global `space-*` utilities are sibling
  // selectors. TanStack memoizes each zone, so these change only on a move or
  // pin, and they are the explicit reason this recomputes.
  const start = table.getStartLeafColumns();
  const center = table.getCenterLeafColumns();
  const end = table.getEndLeafColumns();
  const bodyRows = useMemo<BodyRow<TData>[]>(() => {
    const columns = [...start, ...center, ...end];
    return rows.map((row) => {
      const cells = new Map(row.getAllCells().map((c) => [c.column.id, c]));
      return { row, cells: columns.flatMap((c) => cells.get(c.id) ?? []) };
    });
  }, [rows, start, center, end]);

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
