import type { Project } from '../types';

import { memo, useCallback } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { cacheRemoved } from '@/utils/query-cache';

import { RowActions } from '@/components/shared/row-actions';

import { PROJECTS_QUERY_KEYS } from '../query-keys';

const TableActions = memo(({ original: project }: { original: Project }) => {
  const queryClient = useQueryClient();
  const onDeleted = useCallback(
    () => cacheRemoved<Project>(queryClient, PROJECTS_QUERY_KEYS, project.id),
    [queryClient, project.id]
  );

  return (
    <RowActions
      editHref={`/dash/projects/edit?projectId=${project.id}`}
      deleteHref={`/api/dash/projects/${project.id}`}
      noun='المشروع'
      name={project.title}
      onDeleted={onDeleted}
    />
  );
});

TableActions.displayName = 'ProjectTableActions';

export { TableActions };
