import type { User } from '../types';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { cacheRemoved } from '@/utils/query-cache';

import { RowActions } from '@/components/shared/row-actions';

import { USERS_QUERY_KEYS } from '../query-keys';

const TableActions = memo(({ original: user }: { original: User }) => {
  const queryClient = useQueryClient();
  const onDeleted = useCallback(
    () => cacheRemoved<User>(queryClient, USERS_QUERY_KEYS, user.id),
    [queryClient, user.id]
  );

  return (
    <RowActions
      editHref={`/dash/users/edit?id=${user.id}`}
      deleteHref={`/api/dash/users/${user.id}`}
      noun='المستخدم'
      name={user.name}
      onDeleted={onDeleted}
    />
  );
});

TableActions.displayName = 'UserTableActions';

export { TableActions };
