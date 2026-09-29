import type { Variants } from 'framer-motion';
import type { ComponentType } from 'react';

import { memo, useEffect } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { MainTabs } from './main-tabs';
import { SmoothHeightContainer } from './smooth-height-container';
import { useTabsStore } from './store';

export interface FormTab {
  id: string;
  label: string;
  Panel: ComponentType;
}

interface FormTabsProps {
  /** A module constant; the first tab is active until another is picked. */
  tabs: readonly [FormTab, ...FormTab[]];
}

const PANEL_TRANSITION = { duration: 0.3, ease: [0.4, 0, 0.2, 1] } as const;

const panelVariants: Variants = {
  initial: { opacity: 0, x: 20, filter: 'blur(4px)' },
  animate: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)',
    transition: PANEL_TRANSITION,
  },
  exit: {
    opacity: 0,
    x: -20,
    filter: 'blur(4px)',
    transition: PANEL_TRANSITION,
  },
};

export const FormTabs = memo(({ tabs }: FormTabsProps) => {
  useEffect(() => () => useTabsStore.getState().reset(), []);

  return (
    <>
      <MainTabs tabs={tabs} />
      <SmoothHeightContainer className='px-1 pb-10 pt-4'>
        <ActivePanel tabs={tabs} />
      </SmoothHeightContainer>
    </>
  );
});

FormTabs.displayName = 'FormTabs';

const ActivePanel = memo(({ tabs }: FormTabsProps) => {
  const activeId = useTabsStore((s) => s.activeMainTab);
  const { id, Panel } = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <AnimatePresence mode='wait'>
      <motion.div
        key={id}
        variants={panelVariants}
        initial='initial'
        animate='animate'
        exit='exit'
      >
        <Panel />
      </motion.div>
    </AnimatePresence>
  );
});

ActivePanel.displayName = 'FormTabsActivePanel';
