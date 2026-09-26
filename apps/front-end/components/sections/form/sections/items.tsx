import type { FieldArrayItemProps } from '@/components/form/field-array';
import type { CreateSectionInput } from '@/utils/validation/sections';

import { memo } from 'react';

import { generateUUIDv7 } from '@/utils';

import SortableFieldArray from '@/components/form/field-array';
import ImageItemCard from '@/components/form/field-array/image-item-card';
import FormInput from '@/components/form/form-input';
import FormTextarea from '@/components/form/form-textarea';

const createItem = () => ({
  id: generateUUIDv7(),
  title: '',
  subtitle: '',
  description: '',
  isActive: true,
  order: 0,
});

const ItemsSection = memo(() => (
  <SortableFieldArray<CreateSectionInput, 'items'>
    name='items'
    createItem={createItem}
    Item={SectionItem}
    addLabel='إضافة عنصر'
    emptyText='لا توجد عناصر بعد'
  />
));

ItemsSection.displayName = 'ItemsSection';

export { ItemsSection };

const SectionItem = memo((props: FieldArrayItemProps) => (
  <ImageItemCard
    {...props}
    statusName={`items.${props.index}.isActive`}
    statusAriaLabel='تبديل حالة العنصر'
  >
    <ItemFields index={props.index} />
  </ImageItemCard>
));

SectionItem.displayName = 'SectionItem';

// LANGUAGES-TODOS: label suffix and `dir` from the active language.
const ItemFields = memo(({ index }: { index: number }) => (
  <div className='space-y-4'>
    <FormInput
      name={`items.${index}.title`}
      label='العنوان'
      dir='rtl'
      className='placeholder:text-foreground'
    />
    <FormInput
      name={`items.${index}.subtitle`}
      label='العنوان الفرعي'
      dir='rtl'
      className='placeholder:text-foreground'
    />
    <FormTextarea
      name={`items.${index}.description`}
      label='الوصف'
      dir='rtl'
      className='py-3 placeholder:text-foreground'
      minRows={2}
      minHeight={50}
      maxRows={4}
      maxHeight={130}
    />
  </div>
));

ItemFields.displayName = 'SectionItemFields';
