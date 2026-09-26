import { memo } from 'react';

import { useController } from 'react-hook-form';

import { StatusSwitch } from '@/components/ui/status-switch';

import FormField from './form-field';

interface FormSwitchProps {
  name: string;
  /** Without one, give `ariaLabel` instead. */
  label?: string;
  /** Only when the switch has no visible label pointing at it. */
  ariaLabel?: string;
  labels?: { checked?: string; unchecked?: string };
  required?: boolean;
  tooltip?: string;
  /** The row/column the label and the switch sit in — per call site. */
  className?: string;
  classNameLabel?: string;
}

const FormSwitch = memo(
  ({
    name,
    label,
    ariaLabel,
    labels,
    required,
    tooltip,
    className,
    classNameLabel = 'mb-0',
  }: FormSwitchProps) => {
    const { field } = useController({ name });

    return (
      <FormField
        name={name}
        label={label}
        required={required}
        tooltip={tooltip}
        className={className}
        classNameLabel={classNameLabel}
      >
        <StatusSwitch
          id={name}
          ref={field.ref}
          name={field.name}
          checked={!!field.value}
          onCheckedChange={field.onChange}
          onBlur={field.onBlur}
          disabled={field.disabled}
          aria-label={ariaLabel}
          labels={labels}
        />
      </FormField>
    );
  }
);

FormSwitch.displayName = 'FormSwitch';

export default FormSwitch;
