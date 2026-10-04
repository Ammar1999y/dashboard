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

// LANGUAGES-TODOS: label suffix and `dir` from the active language.
const BasicInfoSection = memo(({ isEdit = false }: { isEdit?: boolean }) => (
  <div className='space-y-6'>
    <div className='grid grid-cols-3 gap-6'>
      <SlugInput isEdit={isEdit} className='col-span-2' />
      <FormSwitch
        name='isActive'
        label='الحالة'
        className='col-span-1 flex flex-col items-start gap-4 sm:flex-row sm:items-center'
      />
    </div>

    <div className='grid grid-cols-8 gap-6'>
      <FormInput
        name='title'
        label='العنوان الرئيسي'
        dir='rtl'
        required
        classNameField='col-span-8 xs2:col-span-4'
      />
      <FormInput
        name='subtitle'
        label='العنوان الفرعي'
        dir='rtl'
        classNameField='col-span-8 xs2:col-span-4'
      />
    </div>

    <FormTextarea
      name='shortDescription'
      label='وصف مختصر'
      dir='rtl'
      minRows={2}
      minHeight={50}
      maxRows={6}
    />

    <RichDescription label='الوصف الغني' />
  </div>
));

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
      setValue('description', value);
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
