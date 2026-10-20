import type { DataTableFeatures } from '@/components/ui/data-table';
import type { PermissionClient } from '@/types/permission';
import type { ColumnDef } from '@tanstack/react-table';

import { humanReadableNumber } from '@app/shared/utils';

import {
  dateColumn,
  statusColumn,
  textColumn,
} from '@/components/ui/data-table';

import { rowActionsColumn } from '../shared/row-actions';
import { removeRoleOption } from './cache';
import { permissionEntity } from './entity';

export const columns: ColumnDef<DataTableFeatures, PermissionClient>[] = [
  textColumn('roleName', 'اسم الصلاحية', {
    size: 200,
    cellClassName: 'text-start font-medium',
  }),
  textColumn('description', 'الوصف', {
    size: 180,
    cellClassName: 'text-sm text-muted-foreground',
  }),
  {
    accessorKey: 'usersCount',
    id: 'usersCount',
    meta: { label: 'عدد المستخدمين', variant: 'range', placeholder: 'بحث...' },
    // Neither filterable nor sortable on the server: it is a computed
    // subquery, not a column on `roles`.
    enableColumnFilter: false,
    enableSorting: false,
    cell: ({ row }) => (
      <p
        dir='ltr'
        className='bidi-isolate num truncate ps-2 text-base font-normal text-muted-foreground'
      >
        {humanReadableNumber(row.original.usersCount ?? 0)}
      </p>
    ),
    size: 210,
  },
  statusColumn(),
  dateColumn('createdAt', 'تاريخ الإنشاء'),
  dateColumn('updatedAt', 'تاريخ التحديث'),
  rowActionsColumn(
    permissionEntity,
    (permission) => permission.roleName,
    removeRoleOption,
    { ownRole: true }
  ),
];
