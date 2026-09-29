import type { CategoryClient } from '@/types/categories';
import type { ColumnDef } from '@tanstack/react-table';

import {
  dateColumn,
  statusColumn,
  textColumn,
} from '@/components/ui/data-table';

import { rowActionsColumn } from '../shared/row-actions';
import { categoryEntity } from './entity';

export const columns: ColumnDef<CategoryClient>[] = [
  textColumn('title', 'العنوان', { size: 180 }),
  statusColumn(),
  dateColumn('createdAt', 'تاريخ الإنشاء'),
  dateColumn('updatedAt', 'آخر تحديث'),
  rowActionsColumn(categoryEntity, (category) => category.title),
];
