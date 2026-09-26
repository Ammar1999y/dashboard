import type { ComponentProps } from 'react';

import { memo } from 'react';

import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { Input } from '@/components/ui/input';

import FormField from './form-field';

interface FormInputProps extends Omit<ComponentProps<'input'>, 'name'> {
  name: string;
  label: string;
  required?: boolean;
  tip?: string;
  tooltip?: string;
  classNameLabel?: string;
  classNameField?: string;
}

const FormInput = memo(
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
  }: FormInputProps) => {
    const { register } = useFormContext();

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
          autoComplete='off'
          dir='auto'
          className={cn('placeholder:text-right', className)}
          {...rest}
          {...register(name)}
        />
      </FormField>
    );
  }
);

FormInput.displayName = 'FormInput';

export default FormInput;
