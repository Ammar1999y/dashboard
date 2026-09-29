import type { ColumnDef } from '@tanstack/react-table';

/** The id TanStack gives a column: its `id`, else its `accessorKey`. */
function columnIdOf<TData>(column: ColumnDef<TData>): string | undefined {
  if (column.id) return column.id;
  return 'accessorKey' in column && column.accessorKey !== undefined
    ? String(column.accessorKey)
    : undefined;
}

export const columnIdsOf = <TData>(columns: ColumnDef<TData>[]) =>
  columns.flatMap((column) => columnIdOf(column) ?? []);

/** The quick search box matches the text columns, as the server's search fields do. */
export const textColumnIds = <TData>(columns: ColumnDef<TData>[]) =>
  columns.flatMap((column) =>
    column.meta?.variant === 'text' ? (columnIdOf(column) ?? []) : []
  );
