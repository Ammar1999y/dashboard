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

const SocialAccountsSection = memo(() => (
  <SortableFieldArray<SettingsInput, 'socialAccounts'>
    name='socialAccounts'
    createItem={createItem}
    Item={SocialAccountItem}
    addLabel='إضافة حساب'
    emptyText='لا توجد حسابات تواصل بعد'
  />
));

SocialAccountsSection.displayName = 'SocialAccountsSection';

export { SocialAccountsSection };

const SocialAccountItem = memo((props: FieldArrayItemProps) => (
  <ImageItemCard
    {...props}
    statusName={`socialAccounts.${props.index}.isActive`}
    statusAriaLabel='تبديل حالة الحساب'
  >
    <KeyedLinkFields name='socialAccounts' index={props.index} />
  </ImageItemCard>
));

SocialAccountItem.displayName = 'SocialAccountItem';
