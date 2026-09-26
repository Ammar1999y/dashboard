import { memo } from 'react';

import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import { Label } from '@/components/ui/label';
import { FileUpload } from '@/components/file-upload';
import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';
import FormTextarea from '@/components/form/form-textarea';

import CategoryCombobox from './category-combobox';

const ProjectForm = memo(() => {
  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const nativeLang = null;
  const inputDir = 'rtl';

  return (
    <div className='px-1 pb-10 pt-4 space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      <div className='grid grid-cols-3 items-center gap-6'>
        <FormInput
          name='title'
          label={`العنوان${nativeLang ? ` (${nativeLang}) ` : ''}`}
          dir={inputDir}
          required
          classNameField='col-span-2'
        />
        <FormSwitch
          name='isActive'
          label='الحاله'
          className='col-span-1 flex flex-col gap-4'
        />
      </div>

      <FormTextarea
        name='description'
        label={`الوصف${nativeLang ? ` (${nativeLang}) ` : ''}`}
        dir={inputDir}
      />

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

      {/* Images */}
      <div>
        <Label title='الصور' htmlFor='project-images' />
        <FileUpload
          maxFiles={5}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES_WITH_SVG}
          inputID='project-images'
          dropzoneText='اسحب وأفلت الصور هنا، أو'
        />
      </div>
    </div>
  );
});

ProjectForm.displayName = 'ProjectForm';

export { ProjectForm };
