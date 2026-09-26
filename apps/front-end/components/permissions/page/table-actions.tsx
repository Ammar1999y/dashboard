import type { Permission } from '../types';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { cacheRemoved } from '@/utils/query-cache';

import { RowActions } from '@/components/shared/row-actions';

import { removeRoleOption } from '../cache';
import { PERMISSIONS_QUERY_KEYS } from '../query-keys';

const TableActions = memo(
  ({ original: permission }: { original: Permission }) => {
    const queryClient = useQueryClient();
    const onDeleted = useCallback(() => {
      cacheRemoved<Permission>(
        queryClient,
        PERMISSIONS_QUERY_KEYS,
        permission.id
      );
      removeRoleOption(queryClient, permission.id);
    }, [queryClient, permission.id]);

    return (
      <RowActions
        editHref={`/dash/permissions/edit?id=${permission.id}`}
        deleteHref={`/api/dash/permissions/${permission.id}`}
        noun='الصلاحية'
        name={permission.roleName}
        onDeleted={onDeleted}
      />
    );
  }
);

TableActions.displayName = 'PermissionTableActions';

export { TableActions };
