import type { NavItemData, NavProps } from './types';

import Link from 'next/link';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { useDirection } from '@radix-ui/react-direction';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import {
  NavItemCaptionHint,
  navItemClassName,
  NavItemIcon,
  NavItemInfo,
  NavItemLink,
  navLinkProps,
} from './item';
import { useNavItemActive } from './use-nav-item-active';
import { menuChildren, visibleNavItems } from './utils';

type InlineEnd = 'left' | 'right';

/** Radix `side` is physical; this is the side a nested menu opens towards. */
export const useInlineEndSide = (): InlineEnd =>
  useDirection() === 'rtl' ? 'left' : 'right';

export interface FlyoutNavItemContentProps {
  item: NavItemData;
  hasChild: boolean;
}

/** Pass a module constant: every item memoizes against it. */
export interface FlyoutNavVariant {
  navClassName: string;
  listClassName: string;
  itemClassName: string;
  menuSide: 'bottom' | 'inline-end';
  Content: React.ComponentType<FlyoutNavItemContentProps>;
}

const OPEN_DELAY_MS = 100;
const CLOSE_DELAY_MS = 300;

/**
 * A mouse opens the menu by hovering and closes it by leaving; clicks, taps and
 * the keyboard go through Radix unchanged. A mouse press on the trigger while it
 * is open keeps it open, or the click that follows a hover would shut it: Radix
 * toggles on the press and also dismisses it as a press outside the content.
 */
function useHoverMenu() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const schedule = useCallback(
    (next: boolean, delay: number, event: React.PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(next), delay);
    },
    []
  );
  const onPointerEnter = useCallback(
    (event: React.PointerEvent) => schedule(true, OPEN_DELAY_MS, event),
    [schedule]
  );
  const onPointerLeave = useCallback(
    (event: React.PointerEvent) => schedule(false, CLOSE_DELAY_MS, event),
    [schedule]
  );

  const onOpenChange = useCallback((next: boolean) => {
    clearTimeout(timer.current);
    setOpen(next);
  }, []);

  const onTriggerPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (open && event.pointerType === 'mouse') event.preventDefault();
    },
    [open]
  );

  const onPointerDownOutside = useCallback(
    (event: CustomEvent<{ originalEvent: PointerEvent }>) => {
      const { originalEvent } = event.detail;
      if (
        originalEvent.pointerType === 'mouse' &&
        originalEvent.target instanceof Node &&
        triggerRef.current?.contains(originalEvent.target)
      ) {
        event.preventDefault();
      }
    },
    []
  );

  return {
    open,
    onOpenChange,
    triggerProps: {
      ref: triggerRef,
      onPointerDown: onTriggerPointerDown,
      onPointerEnter,
      onPointerLeave,
    },
    contentProps: { onPointerEnter, onPointerLeave, onPointerDownOutside },
  };
}

const MenuEntryContent = memo(({ item }: { item: NavItemData }) => (
  <>
    {item.icon && <NavItemIcon icon={item.icon} />}
    <span className='flex-auto truncate'>{item.title}</span>
    {item.caption && <NavItemCaptionHint caption={item.caption} />}
    {item.info && <NavItemInfo>{item.info}</NavItemInfo>}
  </>
));
MenuEntryContent.displayName = 'MenuEntryContent';

// Text, not `bg-accent`: the menu already marks the focused item that way.
const ACTIVE_ENTRY = 'text-primary focus:text-primary';

const MenuEntry = memo(({ item }: { item: NavItemData }) => {
  const active = useNavItemActive(item);
  const children = menuChildren(item);
  const className = cn(active && ACTIVE_ENTRY);
  const content = <MenuEntryContent item={item} />;

  if (children.length > 0) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className={className}>
          {content}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent>
            {children.map((child) => (
              <MenuEntry key={child.path} item={child} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem asChild disabled={item.disabled} className={className}>
      {item.disabled ? (
        <span>{content}</span>
      ) : (
        <Link {...navLinkProps(item)}>{content}</Link>
      )}
    </DropdownMenuItem>
  );
});
MenuEntry.displayName = 'MenuEntry';

function FlyoutMenu({
  className,
  side,
  content,
  items,
}: {
  className: string;
  side: 'bottom' | InlineEnd;
  content: React.ReactNode;
  items: readonly NavItemData[];
}) {
  const { open, onOpenChange, triggerProps, contentProps } = useHoverMenu();

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild {...triggerProps}>
        <button type='button' className={className}>
          {content}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} sideOffset={10} {...contentProps}>
        {items.map((item) => (
          <MenuEntry key={item.path} item={item} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FlyoutNavItem = memo(
  ({ item, variant }: { item: NavItemData; variant: FlyoutNavVariant }) => {
    const active = useNavItemActive(item);
    const inlineEnd = useInlineEndSide();
    const children = menuChildren(item);
    const className = navItemClassName(
      { active, depth: 1, disabled: item.disabled },
      variant.itemClassName
    );
    const { Content } = variant;
    const content = <Content item={item} hasChild={children.length > 0} />;

    return (
      <li>
        {children.length > 0 ? (
          <FlyoutMenu
            className={className}
            side={variant.menuSide === 'bottom' ? 'bottom' : inlineEnd}
            content={content}
            items={children}
          />
        ) : (
          <NavItemLink item={item} className={className}>
            {content}
          </NavItemLink>
        )}
      </li>
    );
  }
);
FlyoutNavItem.displayName = 'FlyoutNavItem';

/**
 * The top level stays in the page; everything under it opens as a Radix menu,
 * so it is reachable by keyboard and touch. Section names are not shown, so the
 * sections run together as one list.
 */
export const FlyoutNav = memo(
  ({ data, variant }: NavProps & { variant: FlyoutNavVariant }) => (
    <nav className={variant.navClassName}>
      <ul className={variant.listClassName}>
        {visibleNavItems(data.flatMap((section) => section.items)).map(
          (item) => (
            <FlyoutNavItem key={item.path} item={item} variant={variant} />
          )
        )}
      </ul>
    </nav>
  )
);
FlyoutNav.displayName = 'FlyoutNav';
