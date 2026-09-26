import type { CreateSectionInput } from '@/utils/validation/sections';

import dynamic from 'next/dynamic';
import { memo, useCallback, useMemo } from 'react';

import { useFormContext } from 'react-hook-form';

import FormField from '@/components/form/form-field';
import FormInput from '@/components/form/form-input';
import FormSwitch from '@/components/form/form-switch';
import FormTextarea from '@/components/form/form-textarea';
import { SlugInput } from '@/components/form/slug';

const Editor = dynamic(() => import('@/components/editor/plate-editor'), {
  ssr: false,
});

const BasicInfoSection = memo(() => {
  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const nativeLang = null;
  const inputDir = 'rtl';

  return (
    <div className='space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      <div className='grid grid-cols-3 gap-6'>
        <SlugInput className='col-span-2' />
        <FormSwitch
          name='isActive'
          label='الحاله'
          className='col-span-1 flex flex-col items-start gap-4 sm:flex-row sm:items-center'
        />
      </div>

      <div className='grid grid-cols-8 gap-6'>
        <FormInput
          name='title'
          label={`العنوان الرئيسي${nativeLang ? ` (${nativeLang}) ` : ''}`}
          dir={inputDir}
          required
          classNameField='col-span-8 xs2:col-span-4'
        />
        <FormInput
          name='subtitle'
          label={`العنوان الفرعي${nativeLang ? ` (${nativeLang}) ` : ''}`}
          dir={inputDir}
          classNameField='col-span-8 xs2:col-span-4'
        />
      </div>

      <FormTextarea
        name='shortDescription'
        label={`وصف مختصر${nativeLang ? ` (${nativeLang}) ` : ''}`}
        dir={inputDir}
        minRows={2}
        minHeight={50}
        maxRows={6}
      />

      <RichDescription
        label={`الوصف الغني${nativeLang ? ` (${nativeLang}) ` : ''}`}
      />
    </div>
  );
});

BasicInfoSection.displayName = 'BasicInfoSection';

export { BasicInfoSection };

/**
 * Plate owns its own document state and is only seeded once, so the initial
 * value is read with `getValues` — subscribing here would remount the editor on
 * every keystroke it reports back.
 */
const RichDescription = memo(({ label }: { label: string }) => {
  const { setValue, getValues } = useFormContext<CreateSectionInput>();

  const handleChange = useCallback(
    (value: unknown) => {
      setValue('description', value as CreateSectionInput['description']);
    },
    [setValue]
  );

  const initialDescription = useMemo(
    () => getValues('description'),
    [getValues]
  );

  return (
    <FormField name='description' label={label}>
      <Editor onChange={handleChange} content={initialDescription} />
    </FormField>
  );
});

RichDescription.displayName = 'RichDescription';
