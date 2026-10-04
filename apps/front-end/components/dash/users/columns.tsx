import type { UserClient } from '@/types/user';
import type { ColumnDef } from '@tanstack/react-table';

import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { findCached } from '@/lib/api/query-cache';

import {
  dateColumn,
  statusColumn,
  textColumn,
} from '@/components/ui/data-table';

import { cacheRoleUsersCount } from '../permissions/cache';
import { rowActionsColumn } from '../shared/row-actions';
import { userEntity } from './entity';

export const columns: ColumnDef<UserClient>[] = [
  textColumn('name', 'الاسم'),
  textColumn('email', 'البريد الإلكتروني', {
    size: 220,
    dir: 'ltr',
    cellClassName: 'ps-2 text-sm text-muted-foreground',
  }),
  {
    accessorKey: 'role',
    id: 'role',
    meta: { label: 'الصلاحية', variant: 'multiSelect', placeholder: 'اختر...' },
    // Neither filterable nor sortable on the server: `role` comes from the
    // joined roles table, not a column on `users`.
    enableColumnFilter: false,
    enableSorting: false,
    cell: ({ row }) => (
      <p className='truncate text-sm text-muted-foreground'>
        {row.original.roleId === CUSTOM_ROLE_VALUE
          ? 'مخصص'
          : row.original.role?.roleName}
      </p>
    ),
    size: 200,
  },
  statusColumn('حالة المستخدم', { size: 220 }),
  dateColumn('createdAt', 'تاريخ الإنشاء'),
  dateColumn('updatedAt', 'تاريخ التحديث'),
  rowActionsColumn(
    userEntity,
    (user) => user.name,
    (queryClient, id) =>
      cacheRoleUsersCount(
        queryClient,
        findCached<UserClient>(queryClient, userEntity.keys, id)?.roleId,
        -1
      )
  ),
];
