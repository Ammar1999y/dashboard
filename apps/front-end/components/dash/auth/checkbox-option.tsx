import { memo, useCallback, useId } from 'react';

import { HONOUR_REMEMBER_ME } from '@app/shared/config';
import { MSG_REMEMBER_ME } from '@/constants/messages';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

interface CheckboxOptionProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const CheckboxOption = memo(
  ({ label, checked, onCheckedChange }: CheckboxOptionProps) => {
    const id = useId();

    const handleChange = useCallback(
      (value: boolean | 'indeterminate') => onCheckedChange(value === true),
      [onCheckedChange]
    );

    return (
      <div className='flex items-center gap-3'>
        <Checkbox id={id} checked={checked} onCheckedChange={handleChange} />
        <Label htmlFor={id} title={label} className='mb-0 font-normal' />
      </div>
    );
  }
);

CheckboxOption.displayName = 'CheckboxOption';

/** Offered only where the server honours the choice. */
export const RememberMeOption = memo(
  (props: Omit<CheckboxOptionProps, 'label'>) =>
    HONOUR_REMEMBER_ME ? (
      <CheckboxOption label={MSG_REMEMBER_ME} {...props} />
    ) : null
);

RememberMeOption.displayName = 'RememberMeOption';
