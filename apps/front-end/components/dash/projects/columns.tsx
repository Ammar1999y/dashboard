import type { ProjectClient } from '@/types/projects';
import type { ColumnDef } from '@tanstack/react-table';

import {
  dateColumn,
  statusColumn,
  textColumn,
} from '@/components/ui/data-table';

import { rowActionsColumn } from '../shared/row-actions';
import { projectEntity } from './entity';

export const columns: ColumnDef<ProjectClient>[] = [
  textColumn('title', 'العنوان', { size: 200 }),
  statusColumn(),
  dateColumn('createdAt', 'تاريخ الإنشاء'),
  dateColumn('updatedAt', 'آخر تحديث'),
  rowActionsColumn(projectEntity, (project) => project.title),
];
