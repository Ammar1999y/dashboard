import type { ChangeEvent, KeyboardEvent } from 'react';

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { useMedia } from './context';
import { cancelEdit, commitEdit } from './operations';

interface InlineEditorProps {
  initial: string;
  maxLength: number;
  label: string;
  /** A file's name is selected up to its extension, which renaming keeps. */
  selectStem?: boolean;
  className?: string;
}

/**
 * The name being typed for a rename or a new folder, in the row or tile itself.
 * Enter or leaving the field saves, Escape cancels; a refused name stays to be
 * corrected.
 */
export const InlineEditor = memo(
  ({
    initial,
    maxLength,
    label,
    selectStem = false,
    className,
  }: InlineEditorProps) => {
    const ctx = useMedia();
    const [value, setValue] = useState(initial);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const saving = useRef(false);

    const focusName = useCallback(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      const dot = selectStem ? element.value.lastIndexOf('.') : -1;
      element.setSelectionRange(0, dot > 0 ? dot : element.value.length);
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [selectStem]);

    useEffect(() => {
      focusName();
    }, [focusName]);

    const commit = useCallback(async () => {
      if (saving.current || !input.current) return;
      saving.current = true;
      setBusy(true);
      const done = await commitEdit(ctx, input.current.value);
      saving.current = false;
      if (done) return;
      setBusy(false);
      requestAnimationFrame(focusName);
    }, [ctx, focusName]);

    const onChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
      []
    );

    const onKeyDown = useCallback(
      (event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelEdit(ctx);
        }
      },
      [commit, ctx]
    );

    // Leaving the field saves, unless Escape or Enter already settled it.
    const onBlur = useCallback(() => {
      setTimeout(() => {
        if (input.current && document.activeElement !== input.current)
          void commit();
      }, 0);
    }, [commit]);

    return (
      <input
        ref={input}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        disabled={busy}
        maxLength={maxLength}
        aria-label={label}
        spellCheck={false}
        autoComplete='off'
        dir='auto'
        className={cn(
          'h-[22px] min-w-0 flex-1 rounded border bg-background px-1.5 text-foreground outline-none disabled:opacity-60',
          className
        )}
      />
    );
  }
);

InlineEditor.displayName = 'InlineEditor';
