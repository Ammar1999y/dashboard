import type { LabRow } from './fake-server';
import type {
  CellContext,
  ColumnDef,
  HeaderContext,
  Row,
} from '@tanstack/react-table';
import type { ReactNode } from 'react';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/data-table/column-header';

import { LAB_QUERY_KEY, labServer } from './fake-server';

export const LAB_ACTIONS_COLUMN = 'actions';

// The checker compares rendered text against this, so a cell showing an old
// value is caught even when its row id is right.
export const displayValue = (row: Row<LabRow>, columnId: string): string => {
  const value: unknown = row.getValue(columnId);
  if (columnId === 'createdAt' && typeof value === 'string')
    return value.slice(0, 10);
  return value == null ? '' : String(value);
};

// flexRender mounts these as components; the name is what the render probe reports.
type Renderer<TProps> = (props: TProps) => ReactNode;

const named = <TProps,>(
  fn: Renderer<TProps>,
  displayName: string
): Renderer<TProps> => Object.assign(fn, { displayName });

const header = named<HeaderContext<LabRow, unknown>>(
  ({ column }) => (
    <span data-lab-col={column.id} className='contents'>
      <DataTableColumnHeader
        title={column.columnDef.meta?.label ?? column.id}
      />
    </span>
  ),
  'LabHeader'
);

const cell = named<CellContext<LabRow, unknown>>(
  ({ row, column }) => (
    <span
      data-lab-cell={column.id}
      data-lab-row={row.original.id}
      className='block truncate ps-2'
    >
      {displayValue(row, column.id)}
    </span>
  ),
  'LabCell'
);

const LabRowAction = memo(({ rowId }: { rowId: string }) => {
  const queryClient = useQueryClient();
  const handleClick = useCallback(() => {
    labServer.bumpScore(rowId);
    void queryClient.invalidateQueries({ queryKey: [LAB_QUERY_KEY] });
  }, [queryClient, rowId]);

  return (
    <Button size='sm' variant='outline' onClick={handleClick}>
      score +1
    </Button>
  );
});
LabRowAction.displayName = 'LabRowAction';

const actionsCell = named<CellContext<LabRow, unknown>>(
  ({ row }) => (
    <span
      data-lab-cell={LAB_ACTIONS_COLUMN}
      data-lab-row={row.original.id}
      className='flex justify-center'
    >
      <LabRowAction rowId={row.original.id} />
    </span>
  ),
  'LabActionsCell'
);

export const labColumns: ColumnDef<LabRow>[] = [
  {
    accessorKey: 'name',
    id: 'name',
    meta: { label: 'name', variant: 'text', placeholder: 'search...' },
    enableColumnFilter: true,
    header,
    cell,
  },
  {
    accessorKey: 'email',
    id: 'email',
    meta: { label: 'email', variant: 'text', placeholder: 'search...' },
    enableColumnFilter: true,
    header,
    cell,
    size: 220,
  },
  {
    accessorKey: 'role',
    id: 'role',
    meta: { label: 'role' },
    enableColumnFilter: false,
    enableSorting: false,
    header,
    cell,
    size: 200,
  },
  {
    accessorKey: 'status',
    id: 'status',
    meta: {
      label: 'status',
      variant: 'multiSelect',
      options: [
        { label: 'active', value: 'active' },
        { label: 'suspended', value: 'suspended' },
      ],
    },
    enableColumnFilter: true,
    header,
    cell,
    size: 180,
  },
  {
    accessorKey: 'score',
    id: 'score',
    meta: { label: 'score', variant: 'number' },
    header,
    cell,
    size: 170,
  },
  {
    accessorKey: 'createdAt',
    id: 'createdAt',
    meta: { label: 'createdAt', variant: 'date' },
    enableColumnFilter: true,
    header,
    cell,
    size: 180,
  },
  {
    accessorKey: 'notes',
    id: 'notes',
    meta: { label: 'notes', variant: 'text' },
    header,
    cell,
    size: 260,
  },
  {
    id: LAB_ACTIONS_COLUMN,
    header,
    meta: { label: 'actions' },
    enableHiding: false,
    enableSorting: false,
    enableColumnFilter: false,
    cell: actionsCell,
    size: 120,
    minSize: 120,
  },
];
