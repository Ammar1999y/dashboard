'use client';

import type { TElement } from 'platejs';

import * as React from 'react';

import { FontSizePlugin } from '@platejs/basic-styles/react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { ToolbarButton } from '@/components/ui/toolbar';
import {
  FONT_SIZE_PRESETS,
  HEADING_FONT_SIZES,
  parseFontSize,
  stepFontSize,
} from '@/components/editor/font-size';

const DEFAULT_LABEL = 'الافتراضي';

export function FontSizeToolbarButton() {
  const { editor, tf } = useEditorPlugin(FontSizePlugin);
  const [draft, setDraft] = React.useState('');
  const [isFocused, setIsFocused] = React.useState(false);
  const dirty = React.useRef(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const menuId = React.useId();

  /** The size at the cursor; `null` is the unmarked default. */
  const current = useEditorSelector((editor) => {
    const marked = parseFontSize(editor.api.marks()?.[KEYS.fontSize]);
    if (marked !== null) return marked;
    const [block] = editor.api.block<TElement>() ?? [];
    return (block && HEADING_FONT_SIZES[block.type]) ?? null;
  }, []);

  const apply = (size: number | null) => {
    dirty.current = false;
    if (size === null) editor.tf.removeMarks(KEYS.fontSize);
    else tf.fontSize.addMark(`${size}px`);
    setIsFocused(false);
    editor.tf.focus();
  };

  const commitDraft = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const size = parseFontSize(draft);
    if (size === null) editor.tf.focus();
    else apply(size);
  };

  return (
    <div className='flex items-center gap-1 rounded-md border p-0'>
      <ToolbarButton
        onClick={() => apply(stepFontSize(current, -1))}
        tooltip='تصغير الخط'
      >
        <Icon icon='solar:minus-linear' />
      </ToolbarButton>

      <Popover modal={false} open={isFocused} onOpenChange={setIsFocused}>
        <PopoverAnchor asChild>
          <input
            ref={inputRef}
            aria-label='حجم الخط'
            aria-controls={menuId}
            aria-expanded={isFocused}
            aria-haspopup='dialog'
            role='combobox'
            className={cn(
              'h-full w-14 shrink-0 bg-transparent px-1 text-center text-sm hover:bg-muted',
              current === null && !isFocused && 'text-xs'
            )}
            data-plate-focus='true'
            onClick={() => setIsFocused(true)}
            onBlur={(event) => {
              if (contentRef.current?.contains(event.relatedTarget)) return;
              setIsFocused(false);
              commitDraft();
            }}
            onChange={(event) => {
              dirty.current = true;
              setDraft(event.target.value);
            }}
            onFocus={() => {
              setIsFocused(true);
              setDraft(current === null ? '' : String(current));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commitDraft();
              setIsFocused(false);
              editor.tf.focus();
            }}
            type='text'
            inputMode='numeric'
            value={isFocused ? draft : (current ?? DEFAULT_LABEL)}
          />
        </PopoverAnchor>
        <PopoverContent
          id={menuId}
          ref={contentRef}
          className='w-16 px-px py-1'
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target === inputRef.current) event.preventDefault();
          }}
          onEscapeKeyDown={() => {
            dirty.current = false;
            setIsFocused(false);
            editor.tf.focus();
          }}
        >
          {[null, ...FONT_SIZE_PRESETS].map((size) => (
            <button
              className={cn(
                'flex h-8 w-full items-center justify-center text-sm hover:bg-accent data-[highlighted=true]:bg-accent',
                size === null && 'text-xs'
              )}
              data-highlighted={size === current}
              key={size ?? 'default'}
              onClick={() => {
                apply(size);
                setIsFocused(false);
              }}
              type='button'
            >
              {size ?? DEFAULT_LABEL}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <ToolbarButton
        onClick={() => apply(stepFontSize(current, 1))}
        tooltip='تكبير الخط'
      >
        <Icon icon='solar:add-linear' />
      </ToolbarButton>
    </div>
  );
}
