import type { Transition } from 'framer-motion';

import { memo, useCallback } from 'react';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

import { MainTabsAnimatedBackground } from './main-tabs-animated-background';
import { useTabsStore } from './store';

interface TabConfig {
  id: string;
  label: string;
}

const underlineTransition: Transition = {
  duration: 0.3,
  type: 'spring',
  stiffness: 200,
  damping: 20,
  mass: 1,
};

const MainTabs = memo(({ tabs }: { tabs: readonly TabConfig[] }) => {
  return (
    <ScrollArea viewportClassName='pb-3 pt-1 px-1'>
      <div className='relative flex items-center gap-2'>
        <div className='absolute inset-x-0 -bottom-1.5 h-0.5 w-full bg-border' />

        {tabs.map((tab, i) => (
          <TabButton key={tab.id} tab={tab} index={i} />
        ))}
      </div>
      <ScrollBar orientation='horizontal' />
    </ScrollArea>
  );
});
MainTabs.displayName = 'MainTabs';

export { MainTabs };

const TabButton = memo(({ tab, index }: { tab: TabConfig; index: number }) => {
  const isActive = useTabsStore(
    (s) => s.activeMainTab === tab.id || (index === 0 && !s.activeMainTab)
  );

  const handleClick = useCallback(() => {
    useTabsStore.getState().setActiveMainTab(tab.id);
  }, [tab.id]);

  const onHover = useCallback(() => {
    useTabsStore.getState().setHoveredMainTab(tab.id);
  }, [tab.id]);

  const onLeave = useCallback(() => {
    useTabsStore.getState().setHoveredMainTab(null);
  }, []);

  return (
    <button
      onClick={handleClick}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={cn(
        'relative h-8 whitespace-nowrap rounded-md px-3 py-2 transition-all duration-300',
        !isActive && 'hover:text-foreground',
        isActive ? 'text-foreground' : 'text-muted-foreground'
      )}
      type='button'
    >
      {!isActive && <MainTabsAnimatedBackground tab={tab.id} />}

      {isActive && (
        <motion.div
          layoutId='underline-main-tabs'
          className='absolute inset-x-0 -bottom-1.5 h-0.5 w-full bg-foreground'
          transition={underlineTransition}
        />
      )}
      <span className='relative z-[1] flex h-full items-center justify-center whitespace-nowrap text-sm font-medium leading-5'>
        {tab.label}
      </span>
    </button>
  );
});
TabButton.displayName = 'TabButton';
