import type { DataTableFeatures } from './features';
import type { HeaderContext, RowData } from '@tanstack/react-table';

import { memo } from 'react';

import { cn } from '@/lib/utils';

interface DataTableColumnHeaderProps {
  title: string;
  className?: string;
}

const DataTableColumnHeader = memo(
  ({ title, className }: DataTableColumnHeaderProps) => (
    <p className={cn('h-full px-2 py-2 font-semibold', className)}>{title}</p>
  )
);

DataTableColumnHeader.displayName = 'DataTableColumnHeader';

/** Every column's header unless it sets its own: its `meta.label`. */
function renderDefaultHeader<TData extends RowData>({
  column,
}: HeaderContext<DataTableFeatures, TData>) {
  return (
    <DataTableColumnHeader title={column.columnDef.meta?.label ?? column.id} />
  );
}

export { DataTableColumnHeader, renderDefaultHeader };
