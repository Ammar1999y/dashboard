'use client';

import type { IconName } from '@/components/ui/icon';
import type * as React from 'react';

import { KEYS } from 'platejs';
import { useMarkToolbarButton, useMarkToolbarButtonState } from 'platejs/react';

import { useFormatShortcut } from '@/hooks/use-format-shortcut';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';

function MarkToolbarButton({
  clear,
  nodeType,
  ...props
}: React.ComponentProps<typeof ToolbarButton> & {
  nodeType: string;
  clear?: string[] | string;
}) {
  const state = useMarkToolbarButtonState({ clear, nodeType });
  const { props: buttonProps } = useMarkToolbarButton(state);

  return <ToolbarButton {...props} {...buttonProps} />;
}

const BASIC_MARKS: {
  nodeType: string;
  label: string;
  shortcut: string;
  icon: IconName;
}[] = [
  {
    nodeType: KEYS.bold,
    label: 'عريض',
    shortcut: 'B',
    icon: 'solar:text-bold-linear',
  },
  {
    nodeType: KEYS.italic,
    label: 'مائل',
    shortcut: 'I',
    icon: 'solar:text-italic-linear',
  },
  {
    nodeType: KEYS.underline,
    label: 'تحته خط',
    shortcut: 'U',
    icon: 'solar:text-underline-linear',
  },
  {
    nodeType: KEYS.strikethrough,
    label: 'يتوسطه خط',
    shortcut: '⇧+X',
    icon: 'lucide:strikethrough',
  },
  {
    nodeType: KEYS.code,
    label: 'كود',
    shortcut: 'E',
    icon: 'solar:code-linear',
  },
];

/** Bold through inline code, as both toolbars show them. */
export function BasicMarkButtons() {
  const formatShortcut = useFormatShortcut();

  return BASIC_MARKS.map((mark) => (
    <MarkToolbarButton
      key={mark.nodeType}
      nodeType={mark.nodeType}
      tooltip={formatShortcut(mark.label, mark.shortcut)}
    >
      <Icon icon={mark.icon} />
    </MarkToolbarButton>
  ));
}
