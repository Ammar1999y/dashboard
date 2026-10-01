import type { NavItemData, NavProps, NavSection } from './types';

import { memo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Icon } from '@/components/ui/icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  navItemClassName,
  NavItemIcon,
  NavItemInfo,
  NavItemLink,
} from './item';
import { useNavItemActive } from './use-nav-item-active';
import { menuChildren, visibleNavItems } from './utils';

const VerticalItemContent = memo(
  ({ item, hasChild }: { item: NavItemData; hasChild: boolean }) => (
    <>
      <NavItemIcon icon={item.icon} className='me-3' />

      <span className='inline-flex min-h-6 flex-auto flex-col justify-center overflow-hidden'>
        <span className='truncate text-start text-sm font-medium leading-normal'>
          {item.title}
        </span>

        {item.caption && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className='truncate text-start text-xs font-normal leading-normal'>
                {item.caption}
              </span>
            </TooltipTrigger>
            <TooltipContent side='top' align='start'>
              {item.caption}
            </TooltipContent>
          </Tooltip>
        )}
      </span>

      {item.info && <NavItemInfo>{item.info}</NavItemInfo>}

      {hasChild && (
        <Icon
          icon='solar:alt-arrow-right-linear'
          className='ms-1.5 inline-flex size-4 shrink-0 items-center justify-center transition-all duration-300 ease-in-out group-data-[state=open]/nav-item:rotate-90 rtl:rotate-180'
        />
      )}
    </>
  )
);
VerticalItemContent.displayName = 'VerticalItemContent';

function VerticalBranch({
  active,
  className,
  content,
  children,
}: {
  active: boolean;
  className: string;
  content: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(active);
  // The layout outlives navigation, so a branch the user collapsed would
  // otherwise stay shut over the page just opened inside it.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setOpen(true);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={className}>{content}</CollapsibleTrigger>
      <CollapsibleContent className='pb-1 pe-1'>
        <ul className='ms-4 mt-1 flex flex-col gap-1'>{children}</ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

const VerticalItem = memo(
  ({ item, depth }: { item: NavItemData; depth: number }) => {
    const active = useNavItemActive(item);
    const children = menuChildren(item);
    const className = navItemClassName(
      { active, depth, disabled: item.disabled },
      'group/nav-item min-h-11'
    );
    const content = (
      <VerticalItemContent item={item} hasChild={children.length > 0} />
    );

    return (
      <li>
        {children.length > 0 ? (
          <VerticalBranch
            active={active}
            className={className}
            content={content}
          >
            {children.map((child) => (
              <VerticalItem key={child.path} item={child} depth={depth + 1} />
            ))}
          </VerticalBranch>
        ) : (
          <NavItemLink item={item} className={className}>
            {content}
          </NavItemLink>
        )}
      </li>
    );
  }
);
VerticalItem.displayName = 'VerticalItem';

const VerticalSection = memo(({ section }: { section: NavSection }) => (
  <Collapsible defaultOpen className='p-1'>
    {section.name && (
      <CollapsibleTrigger asChild>
        <Button
          variant='none'
          size='none'
          className='group/section relative inline-flex w-full items-center justify-start py-2 pe-2 ps-3 text-muted-foreground transition-all duration-300 ease-in-out hover:ps-5 hover:text-foreground'
        >
          <Icon
            icon='solar:alt-arrow-down-linear'
            className='absolute inline-flex size-4 shrink-0 rotate-90 opacity-0 transition-all duration-300 ease-in-out group-hover/section:opacity-100 group-data-[state=open]/section:rotate-0 ltr:left-1 rtl:right-1'
          />
          <span className='text-xs'>{section.name}</span>
        </Button>
      </CollapsibleTrigger>
    )}
    <CollapsibleContent className='p-1'>
      <ul className='flex w-full flex-col gap-1'>
        {visibleNavItems(section.items).map((item) => (
          <VerticalItem key={item.path} item={item} depth={1} />
        ))}
      </ul>
    </CollapsibleContent>
  </Collapsible>
));
VerticalSection.displayName = 'VerticalSection';

export const NavVertical = memo(({ data }: NavProps) => (
  <nav className='flex w-full flex-col gap-1'>
    {data.map((section, index) => (
      <VerticalSection key={section.name || index} section={section} />
    ))}
  </nav>
));
NavVertical.displayName = 'NavVertical';
