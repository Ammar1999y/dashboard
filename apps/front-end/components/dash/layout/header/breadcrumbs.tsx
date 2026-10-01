import type { NavItemData } from '@/components/dash/nav';

import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, memo } from 'react';

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { indexNavPaths, menuChildren, navTrail } from '@/components/dash/nav';

import { dashboardNav } from '../nav-data';

const NAV_PATHS = indexNavPaths(dashboardNav);
// Past this, the crumbs between the first and the last two fold into a menu.
const MAX_CRUMBS = 3;

const CrumbMenu = memo(
  ({
    items,
    title,
    label,
  }: {
    items: readonly NavItemData[];
    title?: string;
    label?: string;
  }) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        className='flex items-center gap-1 rounded'
        aria-label={label}
      >
        {title ? (
          <>
            <span>{title}</span>
            <Icon icon='solar:alt-arrow-down-linear' className='size-4' />
          </>
        ) : (
          <BreadcrumbEllipsis />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        {items.map((item) => (
          <DropdownMenuItem key={item.path} asChild>
            <Link href={item.path}>{item.title}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
);
CrumbMenu.displayName = 'CrumbMenu';

const Crumb = memo(
  ({ item, current }: { item: NavItemData; current: boolean }) => {
    const children = menuChildren(item);
    if (children.length > 0)
      return <CrumbMenu items={children} title={item.title} />;
    if (current) return <BreadcrumbPage>{item.title}</BreadcrumbPage>;
    return <BreadcrumbLink href={item.path}>{item.title}</BreadcrumbLink>;
  }
);
Crumb.displayName = 'Crumb';

export const Breadcrumbs = memo(() => {
  const trail = navTrail(NAV_PATHS, useRouter().pathname);
  const current = trail[trail.length - 1];
  const folded =
    trail.length > MAX_CRUMBS ? trail.slice(1, 1 - MAX_CRUMBS) : [];
  const shown =
    folded.length > 0 ? [trail[0], ...trail.slice(1 - MAX_CRUMBS)] : trail;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {shown.map((item, index) => (
          <Fragment key={item.path}>
            {index > 0 && <BreadcrumbSeparator />}
            {index === 1 && folded.length > 0 && (
              <>
                <BreadcrumbItem>
                  <CrumbMenu items={folded} label='عرض المسار كاملا' />
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            )}
            <BreadcrumbItem>
              <Crumb item={item} current={item === current} />
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
});
Breadcrumbs.displayName = 'Breadcrumbs';
