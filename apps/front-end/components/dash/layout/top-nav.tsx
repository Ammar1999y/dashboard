import { memo } from 'react';

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { NavHorizontal } from '@/components/dash/nav';

import { dashboardNav } from './nav-data';

export const DashboardTopNav = memo(() => (
  <div
    data-slot='slash-layout-nav'
    className='sticky inset-x-0 top-[--layout-header-height] z-app-bar w-full shrink-0 grow-0'
  >
    <ScrollArea className='whitespace-nowrap bg-background px-2'>
      <NavHorizontal data={dashboardNav} />
      <ScrollBar orientation='horizontal' />
    </ScrollArea>
  </div>
));
DashboardTopNav.displayName = 'DashboardTopNav';
