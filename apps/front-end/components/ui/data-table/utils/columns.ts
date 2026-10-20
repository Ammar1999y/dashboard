import type { DataTableFeatures } from '../features';
import type { ColumnDef, RowData } from '@tanstack/react-table';

/** The id TanStack gives a column: its `id`, else its `accessorKey`. */
function columnIdOf<TData extends RowData>(
  column: ColumnDef<DataTableFeatures, TData>
): string | undefined {
  if (column.id) return column.id;
  return 'accessorKey' in column && column.accessorKey !== undefined
    ? String(column.accessorKey)
    : undefined;
}

export const columnIdsOf = <TData extends RowData>(
  columns: ColumnDef<DataTableFeatures, TData>[]
) => columns.flatMap((column) => columnIdOf(column) ?? []);

/** The quick search box matches the text columns, as the server's search fields do. */
export const textColumnIds = <TData extends RowData>(
  columns: ColumnDef<DataTableFeatures, TData>[]
) =>
  columns.flatMap((column) =>
    column.meta?.variant === 'text' ? (columnIdOf(column) ?? []) : []
  );
