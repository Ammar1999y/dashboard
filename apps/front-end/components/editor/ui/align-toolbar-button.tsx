'use client';

import * as React from 'react';

import { TextAlignPlugin } from '@platejs/basic-styles/react';
import { useEditorPlugin, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';
import { ALIGN_ITEMS, alignIcon } from '@/components/editor/align';

export function AlignToolbarButton() {
  const { editor, tf } = useEditorPlugin(TextAlignPlugin);
  const value = useSelectionFragmentProp({
    defaultValue: 'start',
    getProp: (node) => node.align,
  });
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='محاذاة'>
          <Icon icon={alignIcon(value)} />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-0'>
        <DropdownMenuRadioGroup
          onValueChange={(next) => {
            const item = ALIGN_ITEMS.find((i) => i.value === next);
            if (item) tf.textAlign.setNodes(item.value);
            editor.tf.focus();
          }}
          value={typeof value === 'string' ? value : undefined}
        >
          {ALIGN_ITEMS.map((item) => (
            <DropdownMenuRadioItem
              aria-label={item.label}
              className='data-[state=checked]:bg-accent'
              indicator='check'
              key={item.value}
              value={item.value}
            >
              <Icon icon={item.icon} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
