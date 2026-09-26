import type { ComponentProps } from 'react';

import { memo } from 'react';

import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';

import FormField from './form-field';

interface FormTextareaProps extends Omit<
  ComponentProps<typeof AutosizeTextarea>,
  'name'
> {
  name: string;
  label: string;
  required?: boolean;
  tip?: string;
  tooltip?: string;
  classNameLabel?: string;
  classNameField?: string;
}

const FormTextarea = memo(
  ({
    name,
    label,
    required,
    tip,
    tooltip,
    classNameLabel,
    classNameField,
    minRows = 3,
    maxRows = 8,
    className,
    ...rest
  }: FormTextareaProps) => {
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
        <AutosizeTextarea
          id={name}
          minRows={minRows}
          maxRows={maxRows}
          dir='auto'
          className={cn('px-3 pb-2 pt-3 placeholder:text-right', className)}
          {...rest}
          {...register(name)}
        />
      </FormField>
    );
  }
);

FormTextarea.displayName = 'FormTextarea';

export default FormTextarea;
