'use client';

import * as React from 'react';

import { LineHeightPlugin } from '@platejs/basic-styles/react';
import { ElementApi, KEYS } from 'platejs';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';
import {
  LINE_HEIGHT_INJECT,
  LINE_HEIGHT_UNSET,
} from '@/components/editor/plugins/config';

const DEFAULT_LABEL = 'الافتراضي';

// Radix radio values are strings; the stored line height is a number.
const OPTIONS = LINE_HEIGHT_INJECT.nodeProps.validNodeValues.map((value) => ({
  key: String(value),
  label: typeof value === 'number' ? String(value) : DEFAULT_LABEL,
  value,
}));

export function LineHeightToolbarButton() {
  const editor = useEditorRef();
  const value = useSelectionFragmentProp({
    defaultValue: LINE_HEIGHT_UNSET,
    getProp: (node) =>
      node.lineHeight === undefined ? undefined : String(node.lineHeight),
  });
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='ارتفاع السطر'>
          <Icon icon='lucide:text-wrap' />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-0'>
        <DropdownMenuRadioGroup
          onValueChange={(key) => {
            const option = OPTIONS.find((o) => o.key === key);
            if (!option) return;
            if (typeof option.value === 'number') {
              editor
                .getTransforms(LineHeightPlugin)
                .lineHeight.setNodes(option.value);
            } else {
              editor.tf.unsetNodes(KEYS.lineHeight, {
                match: (node) => ElementApi.isElement(node),
              });
            }
            editor.tf.focus();
          }}
          value={value}
        >
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              className='min-w-44'
              indicator='check'
              key={option.key}
              value={option.key}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
