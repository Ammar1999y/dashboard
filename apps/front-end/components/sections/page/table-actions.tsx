import type { Section } from '../types';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { cacheRemoved } from '@/utils/query-cache';

import { RowActions } from '@/components/shared/row-actions';

import { SECTIONS_QUERY_KEYS } from '../query-keys';

const TableActions = memo(({ original: section }: { original: Section }) => {
  const queryClient = useQueryClient();
  const onDeleted = useCallback(
    () => cacheRemoved<Section>(queryClient, SECTIONS_QUERY_KEYS, section.id),
    [queryClient, section.id]
  );

  return (
    <RowActions
      editHref={`/dash/sections/edit?sectionId=${section.id}`}
      deleteHref={`/api/dash/sections/${section.id}`}
      noun='القسم'
      name={section.title ?? ''}
      onDeleted={onDeleted}
    />
  );
});

TableActions.displayName = 'SectionTableActions';

export { TableActions };
