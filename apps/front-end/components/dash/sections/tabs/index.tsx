import type { FormTab } from '@/components/form/tabs/form-tabs';
import type { ComponentType } from 'react';

import { memo } from 'react';

import { BasicInfoSection } from './basic';
import { ImagesSection } from './images';
import { ItemsSection } from './items';

const sectionTabs = (Basic: ComponentType) =>
  [
    { id: 'basic', label: 'المعلومات الأساسية', Panel: Basic },
    { id: 'images', label: 'الصور', Panel: ImagesSection },
    { id: 'items', label: 'العناصر', Panel: ItemsSection },
  ] as const satisfies readonly [FormTab, ...FormTab[]];

const EditBasicInfoSection = memo(() => <BasicInfoSection isEdit />);
EditBasicInfoSection.displayName = 'EditBasicInfoSection';

export const CREATE_SECTION_TABS = sectionTabs(BasicInfoSection);
export const EDIT_SECTION_TABS = sectionTabs(EditBasicInfoSection);
