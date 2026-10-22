import type { SettingsInput } from '@/utils/validation/settings';

import { memo, useCallback } from 'react';

import { useFormContext } from 'react-hook-form';

import { ColorPicker } from '@/components/ui/color-picker';
import FormField from '@/components/form/form-field';
import FormInput from '@/components/form/form-input';
import FormTextarea from '@/components/form/form-textarea';

const BasicInfoSection = memo(() => {
  // LANGUAGES-TODOS: `dir` from the active language.
  const inputDir = 'rtl';

  return (
    <div className='space-y-6'>
      <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
        <FormInput
          name='siteTitle'
          label='عنوان الموقع'
          dir={inputDir}
          placeholder='اسم الموقع'
        />
        <PrimaryColorField />
      </div>

      <FormTextarea
        name='siteDescription'
        label='وصف الموقع'
        dir={inputDir}
        placeholder='وصف مختصر للموقع'
        minRows={2}
        maxRows={4}
      />

      <FormTextarea
        name='footerDescription'
        label='وصف الفوتر'
        dir={inputDir}
        placeholder='نص يظهر في أسفل الموقع'
        minRows={2}
        maxRows={4}
      />

      <FormInput
        name='copyrightText'
        label='نص الحقوق'
        dir={inputDir}
        placeholder='جميع الحقوق محفوظة © 2024'
      />
    </div>
  );
});

BasicInfoSection.displayName = 'BasicInfoSection';

export { BasicInfoSection };

/**
 * `ColorPicker` is uncontrolled past its first render, so the value is read with
 * `getValues` rather than watched — a subscription here would re-render the
 * picker on every channel drag it emits.
 */
const PrimaryColorField = memo(() => {
  const { setValue, getValues } = useFormContext<SettingsInput>();

  const handleChange = useCallback(
    (value: string) => {
      setValue('primaryColor', value);
    },
    [setValue]
  );

  return (
    <FormField name='primaryColor'>
      <ColorPicker
        label='اللون الرئيسي'
        onChange={handleChange}
        value={getValues('primaryColor')}
        alpha={false}
      />
    </FormField>
  );
});

PrimaryColorField.displayName = 'PrimaryColorField';
