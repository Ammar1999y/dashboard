'use client';

import type { PlateElementProps } from 'platejs/react';

import { useCalloutEmojiPicker } from '@platejs/callout/react';
import { useEmojiDropdownMenuState } from '@platejs/emoji/react';
import { PlateElement } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  CALLOUT_CLASS,
  CALLOUT_DEFAULT_ICON,
  calloutStyle,
  EMOJI_FONT_STYLE,
} from '@/components/editor/styles';

import { EmojiPicker, EmojiPopover } from './emoji-toolbar-button';

export function CalloutElement({
  attributes,
  children,
  className,
  ...props
}: PlateElementProps) {
  const { emojiPickerState, isOpen, setIsOpen } = useEmojiDropdownMenuState({
    closeOnSelect: true,
  });
  const { emojiToolbarDropdownProps, props: calloutProps } =
    useCalloutEmojiPicker({ isOpen, setIsOpen });
  const { backgroundColor, icon } = props.element;

  return (
    <PlateElement
      attributes={{ ...attributes, 'data-plate-open-context-menu': true }}
      className={cn(CALLOUT_CLASS, className)}
      style={calloutStyle(backgroundColor)}
      {...props}
    >
      <div className='flex w-full gap-2 rounded-md'>
        <EmojiPopover
          {...emojiToolbarDropdownProps}
          control={
            <Button
              className='size-6 select-none p-1 text-lg hover:bg-muted-foreground/15'
              contentEditable={false}
              style={EMOJI_FONT_STYLE}
              variant='ghost'
            >
              {(typeof icon === 'string' && icon) || CALLOUT_DEFAULT_ICON}
            </Button>
          }
        >
          <EmojiPicker {...emojiPickerState} {...calloutProps} />
        </EmojiPopover>
        <div className='w-full'>{children}</div>
      </div>
    </PlateElement>
  );
}
