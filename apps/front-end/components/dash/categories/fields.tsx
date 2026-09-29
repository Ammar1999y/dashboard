import { memo } from 'react';

import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';

// LANGUAGES-TODOS: label suffix and `dir` from the active language.
export const CategoryFields = memo(() => (
  <div className='formContentPadding'>
    <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
      <FormInput name='title' label='العنوان' dir='rtl' required />
      <FormSwitch
        name='isActive'
        label='الحالة'
        className='flex items-center gap-6 sm:flex-col sm:items-start sm:gap-4'
      />
    </div>
  </div>
));

CategoryFields.displayName = 'CategoryFields';
