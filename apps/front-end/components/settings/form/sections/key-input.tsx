import type { SettingsInput } from '@/utils/validation/settings';
import type { FieldPath } from 'react-hook-form';

import { memo } from 'react';

import FormInput from '@/components/form/form-input';

const TOOLTIP = 'يقبل الأحرف الإنجليزية الصغيرة والأرقام والشرطات (-).';

interface KeyInputProps {
  name: FieldPath<SettingsInput>;
  className?: string;
}

const KeyInput = memo(({ name, className }: KeyInputProps) => (
  <FormInput
    name={name}
    label='المفتاح'
    dir='ltr'
    tooltip={TOOLTIP}
    classNameField={className}
  />
));

KeyInput.displayName = 'KeyInput';

export { KeyInput };
