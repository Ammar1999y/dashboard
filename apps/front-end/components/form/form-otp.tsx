import type { ComponentProps } from 'react';

import { memo, useCallback } from 'react';

import { useController } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { cleanOtpInput } from '@/utils/otp-code';

import { Input } from '@/components/ui/input';

import FormField from './form-field';

interface FormOtpProps extends Omit<
  ComponentProps<'input'>,
  | 'name'
  | 'type'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'onBlur'
  | 'inputMode'
  | 'autoComplete'
> {
  name: string;
  label: string;
  required?: boolean;
  tip?: string;
  tooltip?: string;
  classNameLabel?: string;
  classNameField?: string;
}

/**
 * The field for a one-time code. The digits are always left to right, in an
 * RTL page too; every keystroke and paste is cleaned to Latin digits
 * (`cleanOtpInput`), so a code pasted from a message arrives whole. The browser
 * offers the code a message carries through `autocomplete='one-time-code'`.
 *
 * Validate it with `otpCodeSchema` from `@app/shared/validation/otp`, which is
 * the server's own rule.
 */
const FormOtp = memo(
  ({
    name,
    label,
    required,
    tip,
    tooltip,
    classNameLabel,
    classNameField,
    className,
    ...rest
  }: FormOtpProps) => {
    const { field } = useController({ name });
    const { onChange } = field;

    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) =>
        onChange(cleanOtpInput(event.target.value)),
      [onChange]
    );

    return (
      <FormField
        name={name}
        label={label}
        required={required}
        tip={tip}
        tooltip={tooltip}
        className={classNameField}
        classNameLabel={classNameLabel}
      >
        <Input
          id={name}
          type='text'
          inputMode='numeric'
          autoComplete='one-time-code'
          dir='ltr'
          className={cn('text-center tracking-widest', className)}
          {...rest}
          name={field.name}
          ref={field.ref}
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={handleChange}
          onBlur={field.onBlur}
        />
      </FormField>
    );
  }
);

FormOtp.displayName = 'FormOtp';

export default FormOtp;
