import type { LabelHTMLAttributes } from 'react';

import { memo } from 'react';

import { cn } from '@/lib/utils';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  title: string;
}

const Label = memo(
  ({ className, required = false, title, ...props }: LabelProps) => {
    return (
      <label
        className={cn(
          'mb-2 block text-sm font-semibold text-foreground',
          className
        )}
        {...props}
      >
        {title} {required && <span className='text-destructive'>*</span>}
      </label>
    );
  }
);

Label.displayName = 'Label';

export { Label };
