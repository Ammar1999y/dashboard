'use client';

import type * as React from 'react';

import {
  useLinkToolbarButton,
  useLinkToolbarButtonState,
} from '@platejs/link/react';

import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';

export function LinkToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const state = useLinkToolbarButtonState();
  const { props: buttonProps } = useLinkToolbarButton(state);

  return (
    <ToolbarButton {...props} {...buttonProps} data-plate-focus tooltip='رابط'>
      <Icon icon='solar:link-linear' />
    </ToolbarButton>
  );
}
