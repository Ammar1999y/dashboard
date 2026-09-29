import { memo } from 'react';

import { Label } from '@/components/ui/label';
import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';
import FormTextarea from '@/components/form/form-textarea';
import { FileUpload } from '@/components/shared/file-upload';

import { CategoryCombobox } from './category-combobox';

// LANGUAGES-TODOS: label suffix and `dir` from the active language.
export const ProjectFields = memo(() => (
  <div className='formContentPadding space-y-6'>
    <div className='grid grid-cols-3 items-center gap-6'>
      <FormInput
        name='title'
        label='العنوان'
        dir='rtl'
        required
        classNameField='col-span-2'
      />
      <FormSwitch
        name='isActive'
        label='الحالة'
        className='col-span-1 flex flex-col gap-4'
      />
    </div>

    <FormTextarea name='description' label='الوصف' dir='rtl' />

    <div className='grid grid-cols-1 gap-4 xs2:grid-cols-8'>
      <FormInput
        name='link'
        label='الرابط'
        dir='ltr'
        placeholder='https://example.com'
        className='placeholder:!text-left'
        classNameField='xs2:col-span-5'
      />
      <CategoryCombobox className='xs2:col-span-3' />
    </div>

    <div>
      <Label title='الصور' htmlFor='project-images' />
      <FileUpload maxFiles={5} inputId='project-images' />
    </div>
  </div>
));

ProjectFields.displayName = 'ProjectFields';
