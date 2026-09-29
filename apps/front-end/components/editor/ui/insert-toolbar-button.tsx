'use client';

import * as React from 'react';

import { useEditorRef } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton, ToolbarMenuGroup } from '@/components/ui/toolbar';
import { INSERT_GROUPS } from '@/components/editor/block-types';
import { insertItem } from '@/components/editor/transforms';

export function InsertToolbarButton() {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='إدراج'>
          <Icon icon='solar:add-linear' />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align='start'
        className='flex max-h-[500px] min-w-0 flex-col overflow-y-auto'
      >
        {INSERT_GROUPS.map((group) => (
          <ToolbarMenuGroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <DropdownMenuItem
                className='min-w-44'
                key={item.value}
                onSelect={() => {
                  insertItem(editor, item);
                  if (item.focusEditor !== false) editor.tf.focus();
                }}
              >
                <Icon icon={item.icon} className={item.iconClassName} />
                {item.label}
              </DropdownMenuItem>
            ))}
          </ToolbarMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
