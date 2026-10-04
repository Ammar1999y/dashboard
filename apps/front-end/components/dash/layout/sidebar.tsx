import { memo, useCallback } from 'react';

import { APP_NAME } from '@/constants';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NavMini, NavVertical } from '@/components/dash/nav';
import {
  ThemeLayout,
  useSettingStore,
} from '@/components/theme-customizer/layout-store';

import Logo from './logo';
import { dashboardNav } from './nav-data';

export const DashboardSidebar = memo(({ mini }: { mini: boolean }) => {
  const toggleMini = useCallback(() => {
    useSettingStore
      .getState()
      .actions.setThemeLayout(mini ? ThemeLayout.Vertical : ThemeLayout.Mini);
  }, [mini]);

  return (
    <aside
      data-slot='slash-layout-nav'
      className={cn(
        'fixed inset-y-0 z-nav h-full border-e border-dashed bg-background transition-[width] duration-300 ease-in-out ltr:left-[var(--removed-body-scroll-bar-size,0px)] rtl:right-[var(--removed-body-scroll-bar-size,0px)]',
        mini ? 'w-[--layout-nav-width-mini]' : 'w-[--layout-nav-width]'
      )}
    >
      <div
        className={cn(
          'relative flex h-[--layout-header-height] items-center pe-2 ps-4 pt-[--layout-header-padding-top]',
          mini && 'justify-center'
        )}
      >
        <div className='flex h-full items-center justify-center py-1'>
          <Logo className='h-full max-w-16' />

          <span
            className={cn(
              'overflow-hidden whitespace-nowrap text-xl font-bold transition-[opacity,margin] duration-300 ease-in-out',
              mini ? 'ms-0 max-w-0 opacity-0' : 'ms-4'
            )}
          >
            {APP_NAME}
          </span>
        </div>

        <Button
          variant='outline'
          size='icon'
          onClick={toggleMini}
          aria-label={mini ? 'توسيع القائمة' : 'تصغير القائمة'}
          className='absolute top-1/2 size-7 -translate-y-1/2 bg-background ltr:right-0 ltr:translate-x-1/2 rtl:left-0 rtl:-translate-x-1/2 rtl:rotate-180'
        >
          <Icon
            icon={
              mini ? 'lucide:arrow-right-to-line' : 'lucide:arrow-left-to-line'
            }
            className='size-3'
          />
        </Button>
      </div>

      <ScrollArea className='h-[calc(100vh-var(--layout-header-height))] px-2 text-muted-foreground'>
        {mini ? (
          <NavMini data={dashboardNav} />
        ) : (
          <NavVertical data={dashboardNav} />
        )}
      </ScrollArea>
    </aside>
  );
});
DashboardSidebar.displayName = 'DashboardSidebar';
