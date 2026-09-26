import type { VariantProps } from 'class-variance-authority';

import * as React from 'react';

import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,box-shadow,opacity] duration-300',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        defaultGhost: 'hover:bg-primary/15 hover:text-primary',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 dark:bg-destructive/60 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        destructiveGhost:
          'text-destructive hover:bg-destructive/15 focus-visible:ring-destructive/20',
        outline:
          'border shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input/70',
        outlinePrimary:
          'border border-primary text-primary hover:bg-primary/20 active:bg-primary/35',
        secondary:
          'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        ghostPrimary: 'hover:bg-primary/20 text-primary',
        link: 'text-primary underline-offset-4 hover:underline',
        none: '',
      },
      size: {
        default: 'px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        icon: 'size-9',
        none: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  ref?: React.Ref<HTMLButtonElement>;
  asChild?: boolean;
}

const Button = ({
  className,
  variant,
  size,
  asChild = false,
  disabled = false,
  ref,
  ...props
}: ButtonProps) => {
  const composedClassName = cn(
    disabled && 'disabled',
    buttonVariants({ variant, size, className })
  );

  // The child owns its element: `type` and `disabled` are invalid on an `<a>`.
  if (asChild) {
    return (
      <Slot
        className={composedClassName}
        ref={ref}
        tabIndex={disabled ? -1 : undefined}
        aria-disabled={disabled || undefined}
        {...props}
      />
    );
  }

  return (
    <button
      className={composedClassName}
      ref={ref}
      type='button'
      disabled={disabled}
      {...props}
    />
  );
};
Button.displayName = 'Button';

export { Button, buttonVariants };
