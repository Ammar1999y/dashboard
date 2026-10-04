import type { SettingsInput } from '@/utils/validation/settings';
import type { FieldPath } from 'react-hook-form';

import { memo } from 'react';

import FormInput from '@/components/form/form-input';
import { SLUG_TOOLTIP } from '@/components/form/slug';

interface KeyInputProps {
  name: FieldPath<SettingsInput>;
  className?: string;
}

const KeyInput = memo(({ name, className }: KeyInputProps) => (
  <FormInput
    name={name}
    label='المفتاح'
    dir='ltr'
    tooltip={SLUG_TOOLTIP}
    classNameField={className}
  />
));

KeyInput.displayName = 'KeyInput';

export { KeyInput };
