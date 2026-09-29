import type { FlyoutNavItemContentProps, FlyoutNavVariant } from './flyout-nav';
import type { NavProps } from './types';

import { memo } from 'react';

import { Icon } from '@/components/ui/icon';

import { FlyoutNav } from './flyout-nav';
import { NavItemCaptionHint, NavItemIcon, NavItemInfo } from './item';

const HorizontalItemContent = memo(
  ({ item, hasChild }: FlyoutNavItemContentProps) => (
    <>
      <NavItemIcon icon={item.icon} />

      <span className='ms-2 flex-auto truncate text-start text-sm font-medium leading-normal'>
        {item.title}
      </span>

      {item.caption && (
        <NavItemCaptionHint
          caption={item.caption}
          side='bottom'
          className='ms-1.5'
        />
      )}

      {item.info && <NavItemInfo>{item.info}</NavItemInfo>}

      {hasChild && (
        <Icon
          icon='solar:alt-arrow-down-linear'
          className='ms-1.5 inline-flex size-4 shrink-0 items-center justify-center transition-all duration-300 ease-in-out'
        />
      )}
    </>
  )
);
HorizontalItemContent.displayName = 'HorizontalItemContent';

const HORIZONTAL: FlyoutNavVariant = {
  navClassName:
    'flex min-h-[--layout-nav-height-horizontal] items-center border-b border-dashed text-muted-foreground',
  listClassName: 'flex items-center space-x-1',
  itemClassName: 'min-h-8 max-w-64 text-muted-foreground',
  menuSide: 'bottom',
  Content: HorizontalItemContent,
};

export const NavHorizontal = memo(({ data }: NavProps) => (
  <FlyoutNav data={data} variant={HORIZONTAL} />
));
NavHorizontal.displayName = 'NavHorizontal';
