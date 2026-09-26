import type { ChangeEvent, Ref, TextareaHTMLAttributes } from 'react';

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { cn } from '@/lib/utils';

import useIsomorphicLayoutEffect from '@/hooks/use-layout-effect';

import { fieldSurface } from './field-surface';

// Computed lengths carry their unit (`"1px"`), which `Number` alone rejects.
function parsePx(value: string | null): number {
  if (!value) return 0;
  const n = Number(value.replace('px', '').trim());
  return Number.isNaN(n) ? 0 : n;
}

interface HeightConstraints {
  minRows?: number;
  maxRows?: number;
  minHeight?: number;
  maxHeight?: number;
}

function measureAndSetHeight(
  textarea: HTMLTextAreaElement,
  { minRows, maxRows, minHeight, maxHeight }: HeightConstraints
) {
  textarea.style.height = 'auto';

  const style = getComputedStyle(textarea);
  const borderHeight =
    parsePx(style.borderTopWidth) + parsePx(style.borderBottomWidth);
  const paddingHeight =
    parsePx(style.paddingTop) + parsePx(style.paddingBottom);

  // `line-height: normal` computes to the keyword, not a length.
  const fontSize = parsePx(style.fontSize) || 16;
  const lineHeight = parsePx(style.lineHeight) || fontSize * 1.2;

  const minHeightPx =
    typeof minHeight === 'number'
      ? minHeight
      : typeof minRows === 'number'
        ? minRows * lineHeight + borderHeight + paddingHeight
        : 0;

  const maxHeightPx =
    typeof maxHeight === 'number'
      ? maxHeight
      : typeof maxRows === 'number'
        ? maxRows * lineHeight + borderHeight + paddingHeight
        : Infinity;

  // `scrollHeight` includes padding but not borders.
  const contentHeight = textarea.scrollHeight + borderHeight;
  textarea.style.height = `${Math.max(minHeightPx, Math.min(contentHeight, maxHeightPx))}px`;
  textarea.style.overflowY = contentHeight > maxHeightPx ? 'auto' : 'hidden';
}

type AutosizeTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  HeightConstraints & {
    ref?: Ref<HTMLTextAreaElement>;
  };

export const AutosizeTextarea = memo(
  ({
    className,
    minRows = 4,
    maxRows = 6,
    minHeight = 70,
    maxHeight,
    onChange,
    value,
    defaultValue,
    rows,
    ref,
    ...props
  }: AutosizeTextareaProps) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const lastObservedWidth = useRef<number | null>(null);

    const constraints = useMemo(
      () => ({ minRows, maxRows, minHeight, maxHeight }),
      [minRows, maxRows, minHeight, maxHeight]
    );

    const adjust = useCallback(() => {
      const el = textareaRef.current;
      if (el) measureAndSetHeight(el, constraints);
    }, [constraints]);

    const mergedRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );

    // Before paint, so a value change never shows a frame at the old height.
    useIsomorphicLayoutEffect(() => {
      adjust();
    }, [value, defaultValue, adjust]);

    // Width changes re-wrap the text, so the height has to follow.
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect.width;
          if (width === undefined) return;
          if (
            lastObservedWidth.current === null ||
            Math.abs(width - lastObservedWidth.current) > 0.5
          ) {
            lastObservedWidth.current = width;
            adjust();
          }
        });
        ro.observe(el);
        return () => ro.disconnect();
      }

      window.addEventListener('resize', adjust);
      return () => window.removeEventListener('resize', adjust);
    }, [adjust]);

    const handleChange = useCallback(
      (e: ChangeEvent<HTMLTextAreaElement>) => {
        onChange?.(e);
        adjust();
      },
      [onChange, adjust]
    );

    return (
      <textarea
        data-lenis-prevent
        ref={mergedRef}
        rows={rows ?? minRows}
        className={cn(
          fieldSurface,
          'block w-full min-w-0 resize-none px-3 py-2 caret-primary placeholder:text-muted-foreground',
          className,
          props.disabled && 'disabled'
        )}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        {...props}
      />
    );
  }
);

AutosizeTextarea.displayName = 'AutosizeTextarea';
