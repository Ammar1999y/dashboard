import type { SettingsInput } from '@/utils/validation/settings';

import { memo } from 'react';

import { returnNumberOrNull } from '@/utils';
import { useController, useWatch } from 'react-hook-form';

import { FontCombobox } from '@/components/fonts/form/font-combobox';
import { FontPreview } from '@/components/fonts/form/font-preview';
import FormField from '@/components/form/form-field';
import FormInput from '@/components/form/form-input';

const FontsSection = memo(() => {
  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const inputDir = 'rtl';

  return (
    <div className='space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
        <GoogleFontField />
      </div>

      <div className='grid grid-cols-1 gap-6 sm:grid-cols-3'>
        <FormInput
          name='fonts.letterSpacing'
          label='تباعد الأحرف'
          type='number'
          step='0.5'
          min='-10'
          max='50'
          dir='ltr'
          className='text-center'
          tip='القيمة بالبكسل (0 = طبيعي)'
        />
        <FormInput
          name='fonts.lineHeight'
          label='تباعد الأسطر'
          type='number'
          step='0.1'
          min='0.5'
          max='5'
          dir='ltr'
          className='text-center'
          tip='القيمة الافتراضية 1'
        />
        <FormInput
          name='fonts.fontSizeMultiplier'
          label='مضاعف حجم الخط'
          type='number'
          step='0.1'
          min='0.5'
          max='3'
          dir='ltr'
          className='text-center'
          tip='القيمة الافتراضية 1 (يتم ضربها في حجم الخط الأساسي)'
        />
      </div>

      <LivePreview dir={inputDir} />
    </div>
  );
});

FontsSection.displayName = 'FontsSection';

export { FontsSection };

const GoogleFontField = memo(() => {
  const { field } = useController<SettingsInput, 'fonts.googleFont'>({
    name: 'fonts.googleFont',
  });

  return (
    <FormField name='fonts.googleFont'>
      <FontCombobox
        value={field.value ?? null}
        onChange={field.onChange}
        disabled={field.disabled}
      />
    </FormField>
  );
});

GoogleFontField.displayName = 'GoogleFontField';

/**
 * The only part of this tab that has to follow every keystroke. Kept in its own
 * subscriber so typing in a spacing field does not re-render the whole section.
 */
const LivePreview = memo(({ dir }: { dir: 'rtl' | 'ltr' }) => {
  const fonts = useWatch<SettingsInput, 'fonts'>({ name: 'fonts' });

  return (
    <FontPreview
      fontName={fonts?.googleFont ?? null}
      letterSpacing={returnNumberOrNull(fonts?.letterSpacing) ?? 0}
      lineHeight={returnNumberOrNull(fonts?.lineHeight) ?? 1}
      fontSizeMultiplier={returnNumberOrNull(fonts?.fontSizeMultiplier) ?? 1}
      dir={dir}
    />
  );
});

LivePreview.displayName = 'FontsLivePreview';
