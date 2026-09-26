import type { ComponentType } from 'react';

import { memo, useEffect } from 'react';

import { AnimatedContent } from '@/components/animated-content';
import { SmoothHeightContainer } from '@/components/smooth-height-container';

import { MainTabs } from './main-tabs';
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

const FormTabs = memo(({ tabs }: FormTabsProps) => {
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
    <AnimatedContent keyValue={id}>
      <Panel />
    </AnimatedContent>
  );
});

ActivePanel.displayName = 'FormTabsActivePanel';

export { FormTabs };
