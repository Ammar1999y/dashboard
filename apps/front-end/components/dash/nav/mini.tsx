import type { FlyoutNavItemContentProps, FlyoutNavVariant } from './flyout-nav';
import type { NavProps } from './types';

import { memo } from 'react';

import { Icon } from '@/components/ui/icon';

import { FlyoutNav, useInlineEndSide } from './flyout-nav';
import { NavItemCaptionHint, NavItemIcon } from './item';

const MiniItemContent = memo(
  ({ item, hasChild }: FlyoutNavItemContentProps) => {
    const inlineEnd = useInlineEndSide();

    return (
      <>
        {item.caption && (
          <NavItemCaptionHint
            caption={item.caption}
            side={inlineEnd}
            className='absolute top-2 ltr:left-1 rtl:right-1'
          />
        )}

        <NavItemIcon icon={item.icon} />

        {hasChild && (
          <Icon
            icon='solar:alt-arrow-right-linear'
            className='absolute top-2 size-4 transition-all duration-300 ease-in-out ltr:right-1 rtl:left-1 rtl:rotate-180'
          />
        )}

        <span className='mt-1 line-clamp-2 w-full overflow-hidden whitespace-normal break-words text-center text-sm font-medium leading-normal'>
          {item.title}
        </span>
      </>
    );
  }
);
MiniItemContent.displayName = 'MiniItemContent';

const MINI: FlyoutNavVariant = {
  navClassName: 'flex flex-col',
  listClassName: 'flex flex-col space-y-1',
  itemClassName: 'relative min-h-12 flex-col px-1 pb-1.5 pt-2',
  menuSide: 'inline-end',
  Content: MiniItemContent,
};

export const NavMini = memo(({ data }: NavProps) => (
  <FlyoutNav data={data} variant={MINI} />
));
NavMini.displayName = 'NavMini';
