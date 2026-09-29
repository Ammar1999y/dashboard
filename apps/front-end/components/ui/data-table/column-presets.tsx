import type { ColumnDef } from '@tanstack/react-table';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { tableFormatDate } from '@/components/ui/date/utils';

// The shapes every table repeats. Each returns a plain `ColumnDef`, so a
// table can still spell out any column by hand next to these.

export const ACTIONS_COLUMN = 'actions';

type StringKey<TData> = Extract<keyof TData, string>;

const textOf = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

interface TextColumnOptions {
  size?: number;
  /** Replaces the default `ps-2 font-medium`; `truncate` always applies. */
  cellClassName?: string;
  /** For values in a fixed script regardless of the page, like an email. */
  dir?: 'ltr' | 'rtl';
}

/** A searchable, filterable text column. */
export function textColumn<TData>(
  id: StringKey<TData>,
  label: string,
  { size, cellClassName, dir }: TextColumnOptions = {}
): ColumnDef<TData> {
  const className = cn(
    'truncate',
    dir && 'bidi-isolate',
    cellClassName ?? 'ps-2 font-medium'
  );
  return {
    id,
    accessorKey: id,
    meta: { label, variant: 'text', placeholder: 'بحث...' },
    enableColumnFilter: true,
    cell: ({ getValue }) => (
      <p dir={dir} className={className}>
        {textOf(getValue())}
      </p>
    ),
    size,
  };
}

const STATUS_OPTIONS = [
  { label: 'نشط', value: 'true' },
  { label: 'موقف', value: 'false' },
];

/** The `isActive` badge column, filterable by either state. */
export function statusColumn<TData>(
  label = 'الحالة',
  { size }: { size?: number } = {}
): ColumnDef<TData> {
  return {
    id: 'isActive',
    accessorKey: 'isActive',
    meta: {
      label,
      variant: 'multiSelect',
      placeholder: 'اختر...',
      options: STATUS_OPTIONS,
    },
    enableColumnFilter: true,
    cell: ({ getValue }) => {
      const isActive = getValue() === true;
      return (
        <Badge variant={isActive ? 'activeStatus' : 'inactiveStatus'}>
          {isActive ? 'نشط' : 'موقف'}
        </Badge>
      );
    },
    size,
  };
}

/** A filterable date column, shown in the table's date format. */
export function dateColumn<TData>(
  id: StringKey<TData>,
  label: string
): ColumnDef<TData> {
  return {
    id,
    accessorKey: id,
    meta: { label, variant: 'date', placeholder: 'حدد تاريخ...' },
    enableColumnFilter: true,
    cell: ({ getValue }) => {
      const value = getValue();
      return (
        <p
          dir='ltr'
          className='bidi-isolate num truncate ps-2 text-base font-normal text-muted-foreground'
        >
          {tableFormatDate(typeof value === 'string' ? value : null)}
        </p>
      );
    },
    size: 180,
  };
}

const renderActionsHeader = () => (
  <p className='w-full px-1 text-center font-semibold'>الإجراءات</p>
);

/**
 * The row-actions column. Its id is what the table pins to the end by
 * default; it can be neither hidden, sorted nor filtered.
 */
export function actionsColumn<TData>(
  render: (row: TData) => ReactNode
): ColumnDef<TData> {
  return {
    id: ACTIONS_COLUMN,
    header: renderActionsHeader,
    meta: { label: 'الإجراءات' },
    enableHiding: false,
    enableSorting: false,
    enableColumnFilter: false,
    cell: ({ row }) => render(row.original),
    size: 90,
    minSize: 90,
  };
}
