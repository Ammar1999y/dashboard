'use client';

import type { IconName } from '@/components/ui/icon';

import * as React from 'react';

import { SuggestionPlugin } from '@platejs/suggestion/react';
import { useEditorRef, usePlateState, usePluginOption } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '@/components/ui/toolbar';

type Mode = 'editing' | 'viewing' | 'suggestion';

const MODES: Record<Mode, { icon: IconName; label: string }> = {
  editing: { icon: 'solar:pen-new-square-linear', label: 'تحرير' },
  viewing: { icon: 'solar:eye-bold-duotone', label: 'عرض' },
  suggestion: { icon: 'lucide:pencil-line', label: 'اقتراح' },
};

const MODE_KEYS: Mode[] = ['editing', 'viewing', 'suggestion'];

const isMode = (value: string): value is Mode =>
  (MODE_KEYS as readonly string[]).includes(value);

export function ModeToolbarButton() {
  const editor = useEditorRef();
  const [readOnly, setReadOnly] = usePlateState('readOnly');
  const isSuggesting = usePluginOption(SuggestionPlugin, 'isSuggesting');
  const [open, setOpen] = React.useState(false);

  const mode: Mode = isSuggesting
    ? 'suggestion'
    : readOnly
      ? 'viewing'
      : 'editing';

  const handleChange = (next: string) => {
    if (!isMode(next)) return;
    setReadOnly(next === 'viewing');
    editor.setOption(SuggestionPlugin, 'isSuggesting', next === 'suggestion');
    if (next === 'editing') editor.tf.focus();
  };

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='وضع التحرير'>
          <Icon icon={MODES[mode].icon} />
          <span className='hidden lg:inline'>{MODES[mode].label}</span>
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-44'>
        <DropdownMenuRadioGroup onValueChange={handleChange} value={mode}>
          {MODE_KEYS.map((key) => (
            <DropdownMenuRadioItem indicator='check' key={key} value={key}>
              <Icon icon={MODES[key].icon} />
              {MODES[key].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
