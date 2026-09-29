import type { FieldArrayItemProps } from '@/components/form/field-array';
import type { SettingsInput } from '@/utils/validation/settings';

import { memo } from 'react';

import { generateUUIDv7 } from '@/utils';

import SortableFieldArray from '@/components/form/field-array';
import ImageItemCard from '@/components/form/field-array/image-item-card';

import { KeyedLinkFields } from './keyed-link-fields';

const createItem = () => ({
  id: generateUUIDv7(),
  key: '',
  title: '',
  link: '',
  isActive: true,
  order: 0,
});

const ContactInfoSection = memo(() => (
  <SortableFieldArray<SettingsInput, 'contactInfo'>
    name='contactInfo'
    createItem={createItem}
    Item={ContactInfoItem}
    addLabel='إضافة بيانات تواصل'
    emptyText='لا توجد بيانات تواصل بعد'
  />
));

ContactInfoSection.displayName = 'ContactInfoSection';

export { ContactInfoSection };

const ContactInfoItem = memo((props: FieldArrayItemProps) => (
  <ImageItemCard
    {...props}
    statusName={`contactInfo.${props.index}.isActive`}
    statusAriaLabel='تبديل حالة بيانات التواصل'
  >
    <KeyedLinkFields name='contactInfo' index={props.index} />
  </ImageItemCard>
));

ContactInfoItem.displayName = 'ContactInfoItem';
