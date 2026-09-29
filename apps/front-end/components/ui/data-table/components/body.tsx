import type { BodyRow, TableLayout } from '../hooks/use-table-instance';
import type { PinSide } from '../store/column-store';
import type { Cell } from '@tanstack/react-table';

import { flexRender } from '@tanstack/react-table';

import { DataTableSkeleton } from '../skeleton';
import { genericMemo } from '../utils/generic-memo';
import { DataTableEmptyState } from './data-table-empty-state';
import { DataTableErrorState } from './data-table-error-state';
import { cellAttributes, TableCell, TableRow } from './table-elements';

interface BodyCellProps<TData> {
  cell: Cell<TData, unknown>;
  pinSide: PinSide | undefined;
  pinEdge: boolean;
}

const BodyCellInner = <TData,>({
  cell,
  pinSide,
  pinEdge,
}: BodyCellProps<TData>) => (
  <TableCell
    className='relative transition duration-300'
    {...cellAttributes(cell.column.id, pinSide, pinEdge)}
  >
    {flexRender(cell.column.columnDef.cell, cell.getContext())}
  </TableCell>
);

// TanStack rebuilds every `Cell` when the column order changes; a cell whose
// record, column and pin placement are unchanged renders the same output.
const BodyCell = genericMemo(
  BodyCellInner,
  'DataTableBodyCell',
  (prev, next) =>
    prev.cell.row.original === next.cell.row.original &&
    prev.cell.column === next.cell.column &&
    prev.pinSide === next.pinSide &&
    prev.pinEdge === next.pinEdge
);

interface BodyRowProps<TData> {
  bodyRow: BodyRow<TData>;
  layout: TableLayout<TData>;
}

const BodyRowInner = <TData,>({ bodyRow, layout }: BodyRowProps<TData>) => (
  <TableRow className='group/row transition-colors duration-300 even:bg-muted/50 hover:bg-muted/70'>
    {bodyRow.cells.map((cell) => {
      const pin = layout.pins[cell.column.id];
      // Keyed by column, not `cell.id`: a reordered column keeps its cell
      // instance (and memo), so a reorder only moves DOM nodes.
      return (
        <BodyCell
          key={cell.column.id}
          cell={cell}
          pinSide={pin?.side}
          pinEdge={pin?.edge ?? false}
        />
      );
    })}
  </TableRow>
);

// A refetch builds new row objects even for unchanged records; the record
// itself keeps its identity (React Query's structural sharing). So a row
// re-renders only when its record changed or a prop it hands a cell would —
// the column at a position, or a pin placement; hiding a column changes
// neither (its cells stay, hidden by CSS). Cell renderers must therefore read
// from the row, never from outside state.
function sameRow<TData>(prev: BodyRowProps<TData>, next: BodyRowProps<TData>) {
  const before = prev.bodyRow.cells;
  const after = next.bodyRow.cells;
  if (
    prev.bodyRow.row.original !== next.bodyRow.row.original ||
    before.length !== after.length
  )
    return false;
  return after.every((cell, index) => {
    const oldPin = prev.layout.pins[cell.column.id];
    const newPin = next.layout.pins[cell.column.id];
    return (
      before[index]?.column === cell.column &&
      oldPin?.side === newPin?.side &&
      oldPin?.edge === newPin?.edge
    );
  });
}

const BodyRowView = genericMemo(BodyRowInner, 'DataTableBodyRow', sameRow);

interface DataTableBodyProps<TData> {
  bodyRows: BodyRow<TData>[];
  layout: TableLayout<TData>;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const DataTableBodyInner = <TData,>({
  bodyRows,
  layout,
  isLoading,
  error,
  refetch,
}: DataTableBodyProps<TData>) => {
  if (bodyRows.length > 0)
    return bodyRows.map((bodyRow) => (
      <BodyRowView key={bodyRow.row.id} bodyRow={bodyRow} layout={layout} />
    ));
  if (isLoading) return <DataTableSkeleton columnIds={layout.columnIds} />;
  if (error) return <DataTableErrorState error={error} refetch={refetch} />;
  return <DataTableEmptyState />;
};

const DataTableBody = genericMemo(DataTableBodyInner, 'DataTableBody');

export { DataTableBody };
