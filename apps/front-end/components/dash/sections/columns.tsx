import type { SectionClient } from '@/types/sections';
import type { ColumnDef } from '@tanstack/react-table';

import {
  dateColumn,
  statusColumn,
  textColumn,
} from '@/components/ui/data-table';

import { rowActionsColumn } from '../shared/row-actions';
import { sectionEntity } from './entity';

export const columns: ColumnDef<SectionClient>[] = [
  textColumn('title', 'العنوان الرئيسي', { size: 200 }),
  textColumn('subtitle', 'العنوان الفرعي', {
    size: 200,
    cellClassName: 'ps-2 text-muted-foreground',
  }),
  statusColumn(),
  dateColumn('createdAt', 'تاريخ الإنشاء'),
  dateColumn('updatedAt', 'آخر تحديث'),
  rowActionsColumn(sectionEntity, (section) => section.title ?? ''),
];
