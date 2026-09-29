import type { ComboboxOption } from '@/components/form/form-combobox';
import type { CategoryClient } from '@/types/categories';

import { memo } from 'react';

import { Icon } from '@/components/ui/icon';
import { Link } from '@/components/ui/link';
import FormCombobox from '@/components/form/form-combobox';

import { categoryEntity } from '../categories/entity';

const toOption = (category: CategoryClient): ComboboxOption => ({
  id: category.id,
  label: category.title,
});

const ADD_CATEGORY = (
  <div className='border-t p-1'>
    <Link
      href={categoryEntity.newRoute}
      target='_blank'
      variant='ghost'
      className='w-full justify-start text-sm text-muted-foreground hover:text-foreground'
    >
      <Icon icon='solar:add-linear' className='size-4' />
      <span>إضافة تصنيف جديد</span>
    </Link>
  </div>
);

export const CategoryCombobox = memo(
  ({ className }: { className?: string }) => (
    <FormCombobox
      name='categoryId'
      label='التصنيف'
      placeholder='اختر التصنيف'
      searchPlaceholder='ابحث عن التصنيف...'
      queryKey={categoryEntity.keys.list}
      href={categoryEntity.href}
      toOption={toOption}
      footer={ADD_CATEGORY}
      className={className}
    />
  )
);

CategoryCombobox.displayName = 'CategoryCombobox';
