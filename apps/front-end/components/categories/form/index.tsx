import { memo } from 'react';

import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';

const CategoryForm = memo(() => {
  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const nativeLang = null;
  const inputDir = 'rtl';

  return (
    <div className='px-1 pb-10 pt-4 space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs className='!mb-0' /> */}
      <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
        <FormInput
          name='title'
          label={`العنوان${nativeLang ? ` (${nativeLang}) ` : ''}`}
          dir={inputDir}
          required
        />

        <FormSwitch
          name='isActive'
          label='الحالة'
          className='flex items-center gap-6 sm:flex-col sm:items-start sm:gap-4'
        />
      </div>
    </div>
  );
});

CategoryForm.displayName = 'CategoryForm';

export { CategoryForm };
