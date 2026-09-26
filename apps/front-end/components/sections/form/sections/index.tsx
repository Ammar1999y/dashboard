import type { FormTab } from '@/components/form/tabs/form-tabs';

import { BasicInfoSection } from './basic';
import { ImagesSection } from './images';
import { ItemsSection } from './items';

export const SECTION_TABS = [
  { id: 'basic', label: 'المعلومات الأساسية', Panel: BasicInfoSection },
  { id: 'images', label: 'الصور', Panel: ImagesSection },
  { id: 'items', label: 'العناصر', Panel: ItemsSection },
] as const satisfies readonly [FormTab, ...FormTab[]];
