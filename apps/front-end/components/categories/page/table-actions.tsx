import type { Category } from '../types';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { cacheRemoved } from '@/utils/query-cache';

import { RowActions } from '@/components/shared/row-actions';

import { CATEGORIES_QUERY_KEYS } from '../query-keys';

const TableActions = memo(({ original: category }: { original: Category }) => {
  const queryClient = useQueryClient();
  const onDeleted = useCallback(
    () =>
      cacheRemoved<Category>(queryClient, CATEGORIES_QUERY_KEYS, category.id),
    [queryClient, category.id]
  );

  return (
    <RowActions
      editHref={`/dash/projects/categories/edit?categoryId=${category.id}`}
      deleteHref={`/api/dash/projects/categories/${category.id}`}
      noun='التصنيف'
      name={category.title}
      onDeleted={onDeleted}
    />
  );
});

TableActions.displayName = 'CategoryTableActions';

export { TableActions };
