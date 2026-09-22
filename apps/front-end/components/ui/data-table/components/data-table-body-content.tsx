import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { useShallow } from 'zustand/shallow';

import { DataTableSkeleton } from '../skeleton';
import { useColumnPinning, useTableData, useUpdateRows } from '../store';
import { DataTableBodyRow } from './data-table-body-row';
import { DataTableEmptyState } from './data-table-empty-state';
import { DataTableErrorState } from './data-table-error-state';

const getSaveRowLength = (table: Table<unknown>) => {
  try {
    return table.getRowModel().rows.length;
  } catch {
    return;
  }
};

interface TableBodyContentProps<TData = unknown> {
  table: Table<TData>;
  isLoading: boolean;
  error: Error | null | undefined;
  refetch: () => void;
  columnCount: number;
}

const TableBodyContentInner = <TData,>({
  table,
  isLoading,
  error,
  refetch,
  columnCount,
}: TableBodyContentProps<TData>) => {
  useUpdateRows(useShallow((s) => s.reRender));
  const data = useTableData(useShallow((s) => s.data));
  return data?.length && getSaveRowLength(table as Table<unknown>) ? (
    <DateTableRows table={table} />
  ) : isLoading ? (
    <DataTableSkeleton
      table={table as Table<unknown>}
      columnCount={columnCount}
      rowCount={5}
    />
  ) : error ? (
    <DataTableErrorState error={error || null} refetch={refetch} />
  ) : (
    <DataTableEmptyState />
  );
};

const TableBodyContent = memo(TableBodyContentInner) as <TData>(
  props: TableBodyContentProps<TData>
) => React.ReactElement | null;

const DateTableRowsInner = <TData,>({ table }: { table: Table<TData> }) => {
  useUpdateRows(useShallow((s) => s.reRender));
  useColumnPinning(useShallow((s) => s.columnPinning));
  return table
    .getRowModel()
    .rows.map((row) => <DataTableBodyRow key={row.id} row={row as never} />);
};

const DateTableRows = memo(DateTableRowsInner) as <TData>(props: {
  table: Table<TData>;
}) => React.ReactElement | null;

export { TableBodyContent };
