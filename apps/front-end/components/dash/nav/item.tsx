import type { NavItemData } from './types';
import type { IconName } from '@/components/ui/icon';

import Link from 'next/link';
import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface NavItemState {
  active: boolean;
  depth: number;
  disabled?: boolean;
}

export function navItemClassName(
  { active, depth, disabled }: NavItemState,
  variantClassName?: string
) {
  return cn(
    'inline-flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 align-middle text-sm transition-all duration-300 ease-in-out hover:bg-accent hover:text-accent-foreground/90',
    variantClassName,
    active &&
      (depth === 1
        ? '!bg-primary/hover !text-primary hover:!bg-primary/focus'
        : 'bg-accent text-accent-foreground'),
    disabled &&
      'disabled cursor-not-allowed text-muted-foreground/70 hover:bg-transparent'
  );
}

const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;

export const navLinkProps = (item: NavItemData) => ({
  href: item.path,
  ...(item.newTab && NEW_TAB),
});

export function NavItemLink({
  item,
  className,
  children,
}: {
  item: NavItemData;
  className: string;
  children: React.ReactNode;
}) {
  if (item.disabled) {
    return (
      <button type='button' disabled className={className}>
        {children}
      </button>
    );
  }
  return (
    <Link {...navLinkProps(item)} className={className}>
      {children}
    </Link>
  );
}

export const NavItemIcon = memo(
  ({ icon, className }: { icon?: IconName; className?: string }) => (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center',
        className
      )}
    >
      {icon && <Icon icon={icon} className='size-6' />}
    </span>
  )
);
NavItemIcon.displayName = 'NavItemIcon';

export function NavItemInfo({ children }: { children: React.ReactNode }) {
  return (
    <span className='ms-1.5 inline-flex shrink-0 items-center justify-center'>
      {children}
    </span>
  );
}

export const NavItemCaptionHint = memo(
  ({
    caption,
    side,
    className,
  }: {
    caption: string;
    side?: React.ComponentProps<typeof TooltipContent>['side'];
    className?: string;
  }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>
          <Icon icon='solar:info-circle-linear' className='size-4 opacity-70' />
        </span>
      </TooltipTrigger>
      <TooltipContent side={side}>{caption}</TooltipContent>
    </Tooltip>
  )
);
NavItemCaptionHint.displayName = 'NavItemCaptionHint';
