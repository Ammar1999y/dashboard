import * as React from 'react';

import { cn } from '@/lib/utils';

import { fieldSurface } from './field-surface';

interface InputProps extends React.ComponentProps<'input'> {
  ref?: React.Ref<HTMLInputElement>;
}

const Input = React.memo(({ className, type, ref, ...props }: InputProps) => {
  return (
    <input
      type={type}
      className={cn(
        fieldSurface,
        'flex h-input w-full min-w-0 px-3 py-1 caret-primary placeholder:text-muted-foreground',
        props.disabled && 'disabled !cursor-not-allowed',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
