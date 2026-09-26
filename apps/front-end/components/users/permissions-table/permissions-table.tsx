import type { PermissionsTableProps } from './types';
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { memo, useCallback } from 'react';

import {
  DASHBOARD_PAGES,
  DEFAULT_PAGE_PERMISSIONS,
  getAvailablePermissions,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

import PermissionsChangeHandler from './permissions-change-handler';
import PermissionsTableCell from './permissions-table-cell';
import PermissionsTableHeader from './permissions-table-header';
import { usePermissionsTable } from './use-permissions-table';

const PERMISSION_ACTIONS_LIST = Object.keys(
  PERMISSION_ACTIONS
) as PermissionAction[];

const PermissionsTable = memo(
  ({
    onPermissionsChange,
    className,
    setInitPermissions,
  }: PermissionsTableProps) => {
    const {
      toggleAllView,
      toggleAllEdit,
      toggleAllDelete,
      toggleAllCreate,
      toggleRowAll,
    } = usePermissionsTable(setInitPermissions);

    return (
      <>
        <PermissionsChangeHandler onPermissionsChange={onPermissionsChange} />
        <Table
          className='w-full min-w-96'
          containerClassName={cn('rounded-md overflow-y-hidden', className)}
        >
          <PermissionsTableHeader
            onToggleAllView={toggleAllView}
            onToggleAllEdit={toggleAllEdit}
            onToggleAllDelete={toggleAllDelete}
            onToggleAllCreate={toggleAllCreate}
          />
          <tbody aria-hidden='true' className='h-2' />
          <TableBody>
            {DEFAULT_PAGE_PERMISSIONS.map((page, index) => (
              <PermissionRow
                key={page.name}
                name={page.name}
                index={index}
                onToggleRow={toggleRowAll}
              />
            ))}
          </TableBody>
        </Table>
      </>
    );
  }
);

PermissionsTable.displayName = 'PermissionsTable';
export default PermissionsTable;

interface PermissionRowProps {
  name: DashboardPage;
  index: number;
  onToggleRow: (index: number) => void;
}

/** Its own component so the row's index binds here, not in a closure per render. */
const PermissionRow = memo(
  ({ name, index, onToggleRow }: PermissionRowProps) => {
    const availablePermissions = getAvailablePermissions(name);

    const handleToggleRow = useCallback(
      () => onToggleRow(index),
      [onToggleRow, index]
    );

    return (
      <TableRow className='border-none transition-colors duration-300 even:bg-accent/50 hover:bg-accent'>
        <TableCell className='py-3 font-medium'>
          <div className='flex items-center justify-between'>
            <div className='text-start'>
              <div className='font-semibold'>{DASHBOARD_PAGES[name]}</div>
            </div>
            <button
              onClick={handleToggleRow}
              type='button'
              className='ms-2 rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground'
            >
              اختيار الكل
            </button>
          </div>
        </TableCell>
        {PERMISSION_ACTIONS_LIST.map((action, colIndex) => (
          <TableCell key={action}>
            {availablePermissions.includes(action) && (
              <PermissionsTableCell rowIndex={index} colIndex={colIndex} />
            )}
          </TableCell>
        ))}
      </TableRow>
    );
  }
);

PermissionRow.displayName = 'PermissionRow';
