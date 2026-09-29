'use client';

import type * as React from 'react';

import { useIndentButton, useOutdentButton } from '@platejs/indent/react';

import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';

export function IndentToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const { props: buttonProps } = useIndentButton();

  return (
    <ToolbarButton {...props} {...buttonProps} tooltip='زيادة المسافة'>
      <Icon icon='lucide:list-indent-increase' className='rtl:rotate-180' />
    </ToolbarButton>
  );
}

export function OutdentToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const { props: buttonProps } = useOutdentButton();

  return (
    <ToolbarButton {...props} {...buttonProps} tooltip='تقليل المسافة'>
      <Icon icon='lucide:list-indent-decrease' className='rtl:rotate-180' />
    </ToolbarButton>
  );
}
