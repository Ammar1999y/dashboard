'use client';

import type { TElement } from 'platejs';

import * as React from 'react';

import { KEYS } from 'platejs';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton, ToolbarMenuGroup } from '@/components/ui/toolbar';
import { TURN_INTO_ITEMS } from '@/components/editor/block-types';
import { getBlockType, setBlockType } from '@/components/editor/transforms';

const TOOLTIP = 'تحويل إلى';

export function TurnIntoToolbarButton() {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  const value = useSelectionFragmentProp({
    defaultValue: KEYS.p,
    getProp: (node) => getBlockType(node as TElement),
  });
  const selected =
    TURN_INTO_ITEMS.find((item) => item.value === (value ?? KEYS.p)) ??
    TURN_INTO_ITEMS[0];

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          className='min-w-32'
          isDropdown
          pressed={open}
          tooltip={TOOLTIP}
        >
          {selected?.label}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align='start'
        className='ignore-click-outside/toolbar min-w-0'
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.tf.focus();
        }}
      >
        <ToolbarMenuGroup
          label={TOOLTIP}
          onValueChange={(type) => setBlockType(editor, type)}
          value={value}
        >
          {TURN_INTO_ITEMS.map((item) => (
            <DropdownMenuRadioItem
              className='min-w-44'
              indicator='check'
              key={item.value}
              value={item.value}
            >
              <Icon icon={item.icon} className={item.iconClassName} />
              <span>{item.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </ToolbarMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
