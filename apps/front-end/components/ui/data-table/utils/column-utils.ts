import type { Column, Row, Table } from '@tanstack/react-table';

type ColumnMeta = {
  title: string;
  filterType?: 'search' | 'select';
  filterVariant?: 'text' | 'dateRange' | 'number' | 'numberRange' | 'select';
  options?: { label: string; value: string }[];
};

export interface SearchableColumn {
  id: string;
  label: string;
  filterVariant: 'text' | 'dateRange' | 'number' | 'numberRange';
  column: Column<unknown, unknown> | null;
}

interface SelectFilter<TData = unknown> {
  column: Column<TData, unknown>;
  columnId: string;
  title: string;
}

export const getSearchableColumns = <TData>(
  table: Table<TData>
): SearchableColumn[] => {
  return table
    .getAllColumns()
    .filter((column) => {
      const meta = column.columnDef.meta as ColumnMeta | undefined;
      return meta?.filterType === 'search' && meta?.filterVariant !== 'select';
    })
    .map((column) => ({
      id: column.id,
      label: (column.columnDef.meta as ColumnMeta)?.title || column.id,
      filterVariant:
        (column.columnDef.meta as ColumnMeta)?.filterVariant || 'text',
      column,
    })) as SearchableColumn[];
};

export const getSelectFilters = <TData>(
  table: Table<TData>
): SelectFilter<TData>[] => {
  return table
    .getAllColumns()
    .filter((column) => {
      const meta = column.columnDef.meta as ColumnMeta | undefined;
      return meta?.filterType === 'select';
    })
    .map((column) => ({
      column,
      columnId: column.id,
      title: (column.columnDef.meta as ColumnMeta)?.title || column.id,
    }));
};

export const getAvailableSearchColumns = (
  searchableColumns: SearchableColumn[],
  globalSearch: boolean
): SearchableColumn[] => {
  return globalSearch
    ? [
        {
          id: 'all',
          label: 'الكل',
          filterVariant: 'text' as const,
          column: null,
        },
        ...searchableColumns,
      ]
    : searchableColumns;
};

export const dateBetweenFilterFn = ((row, columnId, value) => {
  const date = row.getValue(columnId) as string;
  if (!date) return false;
  const [start, end] = (value as [string, string]) ?? [];
  if (!start && !end) return true;

  const rowDate = new Date(date);
  if (start && !end) return rowDate >= new Date(start);
  if (!start && end) return rowDate <= new Date(end);
  if (start && end)
    return rowDate >= new Date(start) && rowDate <= new Date(end);
  return true;
}) as <TData>(row: Row<TData>, columnId: string, value: unknown) => boolean;
