import type { NavItemData, NavSection } from './types';

const NONE: readonly NavItemData[] = [];

export function isNavItemActive(item: NavItemData, pathname: string): boolean {
  if (
    pathname === item.path ||
    (!item.exactMatch &&
      !!item.children?.length &&
      pathname.startsWith(`${item.path}/`))
  ) {
    return true;
  }
  return (
    item.children?.some((child) => isNavItemActive(child, pathname)) ?? false
  );
}

export const visibleNavItems = (
  items: readonly NavItemData[]
): readonly NavItemData[] => items.filter((item) => !item.hidden);

/** What opens under an item in a menu or a breadcrumb; a disabled item never opens. */
export const menuChildren = (item: NavItemData): readonly NavItemData[] =>
  item.disabled || !item.children ? NONE : visibleNavItems(item.children);

/** Each path the sections name, mapped to the first item naming it, depth first. */
export function indexNavPaths(
  sections: readonly NavSection[]
): ReadonlyMap<string, NavItemData> {
  const index = new Map<string, NavItemData>();
  const visit = (items: readonly NavItemData[]) => {
    for (const item of items) {
      if (!index.has(item.path)) index.set(item.path, item);
      if (item.children) visit(item.children);
    }
  };
  for (const section of sections) visit(section.items);
  return index;
}

/** The items named by each prefix of `pathname`, outermost first: `/a/b` looks up `/a`, then `/a/b`. */
export function navTrail(
  index: ReadonlyMap<string, NavItemData>,
  pathname: string
): NavItemData[] {
  const trail: NavItemData[] = [];
  let prefix = '';
  for (const segment of pathname.split('/')) {
    if (!segment) continue;
    prefix += `/${segment}`;
    const item = index.get(prefix);
    if (item) trail.push(item);
  }
  return trail;
}
