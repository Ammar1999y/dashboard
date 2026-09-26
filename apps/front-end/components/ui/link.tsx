import type { VariantProps } from 'class-variance-authority';

import NextLink from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { buttonVariants } from './button';

type LinkProps = React.ComponentProps<typeof NextLink> &
  VariantProps<typeof buttonVariants>;

const Link = ({ className, variant, size, ...props }: LinkProps) => (
  <NextLink
    className={cn(buttonVariants({ variant, size, className }))}
    {...props}
  />
);
Link.displayName = 'Link';

export { Link };
