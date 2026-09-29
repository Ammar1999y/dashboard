import type { IconName } from '@/components/ui/icon';

export interface NavItemData {
  /**
   * Matched against the route template (`router.pathname`), so a dynamic page
   * is named as `/dash/users/[id]/edit`. Only a `hidden` item may hold a dynamic
   * segment: the path is also the link.
   */
  path: string;
  title: string;
  icon?: IconName;
  info?: React.ReactNode;
  caption?: string;
  children?: NavItemData[];
  /** Left out of every menu, but still named by the breadcrumb and still marks its ancestors active. */
  hidden?: boolean;
  disabled?: boolean;
  newTab?: boolean;
  /** Active on its own path and its descendants' only, not on every path below it. */
  exactMatch?: boolean;
}

export interface NavSection {
  name?: string;
  items: NavItemData[];
}

export interface NavProps {
  data: readonly NavSection[];
}
