import type { ChangeEvent, ComponentProps } from 'react';

import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { useComposedRefs } from '@radix-ui/react-compose-refs';
import { cn } from '@/lib/utils';

import { fieldSurface } from '@/components/ui/field-surface';

// Computed lengths carry their unit (`"1px"`), which `Number` alone rejects.
function parsePx(value: string | null): number {
  if (!value) return 0;
  const n = Number(value.replace('px', '').trim());
  return Number.isNaN(n) ? 0 : n;
}

/**
 * The text's `scrollHeight`, read from a hidden copy beside the field.
 * Collapsing the field itself would shrink the page under it and move the
 * scroll position and the caret. Beside it, the copy inherits what the field
 * does; its width is pinned, and its scrollbar is hidden so it cannot narrow
 * the lines.
 */
function measureText(textarea: HTMLTextAreaElement, width: string) {
  const copy = textarea.cloneNode() as HTMLTextAreaElement;
  for (const name of ['id', 'name', 'autofocus', 'required'])
    copy.removeAttribute(name);
  copy.setAttribute('aria-hidden', 'true');
  copy.tabIndex = -1;
  Object.assign(copy.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    visibility: 'hidden',
    width,
    height: '0',
    minHeight: '0',
    maxHeight: 'none',
    overflowY: 'hidden',
  });

  textarea.after(copy);
  copy.value = textarea.value;
  // Firefox can report a new textarea's first `scrollHeight` short (bug
  // 1787062); that read flushes it, so the second one is right.
  const height = Math.max(copy.scrollHeight, copy.scrollHeight);
  copy.remove();
  return height;
}

interface RowLimits {
  minRows: number;
  maxRows: number;
}

function measureAndSetHeight(
  textarea: HTMLTextAreaElement,
  { minRows, maxRows }: RowLimits
) {
  const style = getComputedStyle(textarea);
  const borderHeight =
    parsePx(style.borderTopWidth) + parsePx(style.borderBottomWidth);
  const paddingHeight =
    parsePx(style.paddingTop) + parsePx(style.paddingBottom);

  // `line-height: normal` computes to the keyword, not a length.
  const fontSize = parsePx(style.fontSize) || 16;
  const lineHeight = parsePx(style.lineHeight) || fontSize * 1.2;

  const minHeight = minRows * lineHeight + borderHeight + paddingHeight;
  const maxHeight = maxRows * lineHeight + borderHeight + paddingHeight;

  // `scrollHeight` includes padding but not borders.
  const contentHeight = measureText(textarea, style.width) + borderHeight;
  textarea.style.height = `${Math.max(minHeight, Math.min(contentHeight, maxHeight))}px`;
  // `scrollHeight` is rounded to whole pixels while `maxHeight` may be
  // fractional; real overflow is at least a line.
  textarea.style.overflowY = contentHeight - maxHeight > 1 ? 'auto' : 'hidden';
}

type AutosizeTextareaProps = Omit<ComponentProps<'textarea'>, 'rows'> &
  Partial<RowLimits>;

export const AutosizeTextarea = memo(
  ({
    className,
    minRows = 4,
    maxRows = 6,
    onChange,
    value,
    disabled,
    ref,
    ...props
  }: AutosizeTextareaProps) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const composedRef = useComposedRefs(ref, textareaRef);
    const controlled = value !== undefined;

    const adjust = useCallback(() => {
      const el = textareaRef.current;
      if (el) measureAndSetHeight(el, { minRows, maxRows });
    }, [minRows, maxRows]);

    // Before paint, so a change never shows a frame at the old height. Every
    // render, because `style` or `className` can change the text's metrics as
    // surely as `value` does, and `memo` already limits renders to prop changes.
    useLayoutEffect(adjust);

    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;

      // Width changes re-wrap the text, so the height has to follow. Height is
      // ignored: `adjust` writes it, and reacting to that would loop.
      let lastWidth: number | undefined;
      const ro = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width === undefined) return;
        if (lastWidth === undefined || Math.abs(width - lastWidth) > 0.5) {
          lastWidth = width;
          adjust();
        }
      });
      ro.observe(el);

      // Both change the text without moving the box: a web font that loads
      // after the first measure, and `--font-scale`, which
      // theme-customizer/theme-vars.ts writes to the root's inline style
      // among the theme's colors.
      const root = document.documentElement;
      let fontScale = root.style.getPropertyValue('--font-scale');
      const rootStyle = new MutationObserver(() => {
        const next = root.style.getPropertyValue('--font-scale');
        if (next === fontScale) return;
        fontScale = next;
        adjust();
      });
      rootStyle.observe(root, { attributeFilter: ['style'] });
      document.fonts.addEventListener('loadingdone', adjust);

      return () => {
        ro.disconnect();
        rootStyle.disconnect();
        document.fonts.removeEventListener('loadingdone', adjust);
      };
    }, [adjust]);

    // A controlled value is measured once React commits it, which also covers
    // a parent that rejects the edit.
    const handleChange = useCallback(
      (e: ChangeEvent<HTMLTextAreaElement>) => {
        onChange?.(e);
        if (!controlled) adjust();
      },
      [onChange, controlled, adjust]
    );

    return (
      <textarea
        data-lenis-prevent
        ref={composedRef}
        rows={minRows}
        className={cn(
          fieldSurface,
          'block w-full min-w-0 resize-none px-3 py-2 caret-primary placeholder:text-muted-foreground',
          disabled && 'disabled',
          className
        )}
        value={value}
        disabled={disabled}
        onChange={handleChange}
        {...props}
      />
    );
  }
);

AutosizeTextarea.displayName = 'AutosizeTextarea';
