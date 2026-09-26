import type { ComboboxOption } from '@/components/form/form-combobox';
import type { EntityID } from '@/types';

import { memo } from 'react';

import { PlusIcon } from 'lucide-react';

import { Link } from '@/components/ui/link';
import { CATEGORIES_QUERY_KEYS } from '@/components/categories/query-keys';
import FormCombobox from '@/components/form/form-combobox';

interface CategoryOption {
  id: EntityID;
  title: string;
}

const toOption = (category: CategoryOption): ComboboxOption => ({
  id: category.id,
  label: category.title,
});

const ADD_CATEGORY = (
  <div className='border-t p-1'>
    <Link
      href='/dash/projects/categories/new'
      target='_blank'
      variant='ghost'
      className='w-full justify-start text-sm text-muted-foreground hover:text-foreground'
    >
      <PlusIcon className='size-4' />
      <span>إضافة قسم جديد</span>
    </Link>
  </div>
);

const CategoryCombobox = memo(({ className }: { className?: string }) => (
  <FormCombobox
    name='categoryId'
    label='القسم'
    placeholder='اختر القسم'
    searchPlaceholder='ابحث عن القسم...'
    queryKey={CATEGORIES_QUERY_KEYS.list}
    href='/api/dash/projects/categories'
    toOption={toOption}
    footer={ADD_CATEGORY}
    className={className}
  />
));

CategoryCombobox.displayName = 'CategoryCombobox';

export default CategoryCombobox;
