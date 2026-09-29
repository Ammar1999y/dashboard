import type { VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import NextLink from 'next/link';

import { cn } from '@/lib/utils';

import { buttonVariants } from '@/components/ui/button';

type LinkProps = React.ComponentProps<typeof NextLink> &
  VariantProps<typeof buttonVariants>;

function Link({ className, variant, size, ...props }: LinkProps) {
  return (
    <NextLink
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Link };
