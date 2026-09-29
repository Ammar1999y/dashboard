import type { NavItemData } from './types';

import { useRouter } from 'next/router';

import { isNavItemActive } from './utils';

export function useNavItemActive(item: NavItemData): boolean {
  return isNavItemActive(item, useRouter().pathname);
}
