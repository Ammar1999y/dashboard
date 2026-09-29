import type { ComponentProps } from 'react';

import { memo, useCallback, useState } from 'react';

import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

import FormField from './form-field';

interface FormPasswordProps extends Omit<
  ComponentProps<'input'>,
  'name' | 'type'
> {
  name: string;
  label: string;
  required?: boolean;
  autoComplete?: 'current-password' | 'new-password';
  tip?: string;
  classNameLabel?: string;
  classNameField?: string;
}

// The input is `dir='ltr'` inside an RTL page, so the reveal button sits on the
// input's own end edge — the physical right in both page directions.
const FormPassword = memo(
  ({
    name,
    label,
    required,
    autoComplete = 'current-password',
    tip,
    classNameLabel,
    classNameField,
    className,
    ...rest
  }: FormPasswordProps) => {
    const { register } = useFormContext();
    const [visible, setVisible] = useState(false);

    const toggle = useCallback(() => setVisible((prev) => !prev), []);

    return (
      <FormField
        name={name}
        label={label}
        required={required}
        tip={tip}
        className={classNameField}
        classNameLabel={classNameLabel}
      >
        <div className='relative'>
          <Input
            id={name}
            type={visible ? 'text' : 'password'}
            dir='ltr'
            autoComplete={autoComplete}
            className={cn('pe-14 placeholder:text-right', className)}
            {...rest}
            {...register(name)}
          />
          <Button
            variant='none'
            size='icon'
            onClick={toggle}
            aria-label={visible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
            className='absolute top-1/2 -translate-y-1/2 py-1 text-muted-foreground ltr:right-3 rtl:right-3'
          >
            {visible ? (
              <Icon icon='solar:eye-closed-bold-duotone' />
            ) : (
              <Icon icon='solar:eye-bold-duotone' />
            )}
          </Button>
        </div>
      </FormField>
    );
  }
);

FormPassword.displayName = 'FormPassword';

export default FormPassword;
