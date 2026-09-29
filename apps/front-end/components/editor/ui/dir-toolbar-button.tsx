'use client';

import type { DirValue } from '@/components/editor/plugins/dir-kit';
import type { IconName } from '@/components/ui/icon';

import * as React from 'react';

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
import { DIR_VALUES } from '@/components/editor/plugins/dir-kit';

const ITEMS: Record<
  DirValue,
  { icon: IconName; iconClassName?: string; label: string }
> = {
  auto: { icon: 'lucide:arrow-left-right', label: 'اتجاه المستند' },
  ltr: {
    icon: 'fluent:text-direction-horizontal-left-24-regular',
    iconClassName: 'scale-x-[-1]',
    label: 'يسار لليمين',
  },
  rtl: {
    icon: 'fluent:text-direction-horizontal-left-24-regular',
    label: 'يمين لليسار',
  },
};

const isDirValue = (value: unknown): value is DirValue =>
  (DIR_VALUES as readonly unknown[]).includes(value);

export function DirToolbarButton() {
  const editor = useEditorRef();
  const selected = useSelectionFragmentProp({
    defaultValue: 'auto',
    getProp: (node) => node.dir,
  });
  const value = isDirValue(selected) ? selected : 'auto';
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='اتجاه النص'>
          <Icon
            icon={ITEMS[value].icon}
            className={ITEMS[value].iconClassName}
          />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-40'>
        <DropdownMenuRadioGroup
          onValueChange={(next) => {
            if (!isDirValue(next)) return;
            editor.tf.setNodes({ dir: next }, { block: true });
            editor.tf.focus();
          }}
          value={value}
        >
          {DIR_VALUES.map((dir) => (
            <DropdownMenuRadioItem
              className='data-[state=checked]:bg-accent'
              indicator='check'
              key={dir}
              value={dir}
            >
              <Icon
                icon={ITEMS[dir].icon}
                className={ITEMS[dir].iconClassName}
              />
              <span>{ITEMS[dir].label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
