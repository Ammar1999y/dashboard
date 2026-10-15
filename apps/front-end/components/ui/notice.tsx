import type { VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const noticeVariants = cva('rounded-md border p-3 text-sm', {
  variants: {
    tone: {
      info: 'border-border bg-muted text-muted-foreground',
      warning: 'border-warning/30 bg-warning/10 text-warning-dark',
      destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: { tone: 'warning' },
});

/**
 * A boxed note for what the reader must weigh before going on. A `div`, so it
 * can hold a list or an action beside its text.
 */
function Notice({
  className,
  tone,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof noticeVariants>) {
  return (
    <div
      data-slot='notice'
      className={cn(noticeVariants({ tone }), className)}
      {...props}
    />
  );
}

export { Notice };
