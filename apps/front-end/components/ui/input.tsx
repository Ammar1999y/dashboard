import * as React from 'react';

import { cn } from '@/lib/utils';

import { fieldSurface } from '@/components/ui/field-surface';

const Input = React.memo(
  ({ className, disabled, ...props }: React.ComponentProps<'input'>) => (
    <input
      className={cn(
        fieldSurface,
        'flex h-input w-full min-w-0 px-3 py-1 caret-primary placeholder:text-muted-foreground',
        disabled && 'disabled',
        className
      )}
      disabled={disabled}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { Input };
