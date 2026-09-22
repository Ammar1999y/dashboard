import { memo } from 'react';

import { type Column } from '@tanstack/react-table';
import { cn } from '@/lib/utils';

interface DataTableColumnHeaderProps<TData = unknown, TValue = unknown> {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}

const DataTableColumnHeaderInner = <TData, TValue>({
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) => {
  return (
    <p className={cn('h-full px-2 py-2 font-semibold', className)}>{title}</p>
  );
};

const DataTableColumnHeader = memo(DataTableColumnHeaderInner) as <
  TData = unknown,
  TValue = unknown,
>(
  props: DataTableColumnHeaderProps<TData, TValue>
) => React.ReactElement | null;

export { DataTableColumnHeader };
