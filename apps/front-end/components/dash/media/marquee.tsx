import type { MediaContext } from './context';
import type { ItemKey } from '@/lib/media/keys';
import type { SelectionColumn } from '@/lib/media/selection';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { memo, useMemo } from 'react';

import { create } from 'zustand';
import { isItemKey } from '@/lib/media/keys';
import { getSelection, setSelection } from '@/lib/media/selection';

import styles from './media.module.css';
import { clearSelection, select } from './navigation';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const useMarqueeBox = create<{ box: Box | null }>(() => ({ box: null }));

/** Pixels the pointer moves before a press on empty space becomes a box. */
const THRESHOLD = 5;
const EDGE = 24;
const SCROLL_STEP = 14;

/** What a press on these starts is theirs, not a box selection. */
const NOT_EMPTY =
  '[data-item],button,a,input,label,header,[data-no-marquee],[role=row]';

/** The column a container lists, as its `data-col` names it. */
export function columnOf(element: Element | null): SelectionColumn | undefined {
  const host = element?.closest<HTMLElement>('[data-col]');
  const value = host?.dataset.col;
  if (value === undefined) return undefined;
  const named = (['grid', 'list', 'results'] as const).find(
    (column) => column === value
  );
  if (named) return named;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : undefined;
}

/**
 * A press on empty space in a list: dragged, it selects what the box covers,
 * adding to the selection with Ctrl, ⌘ or Shift; a plain click clears it.
 */
export function startMarquee(
  ctx: MediaContext,
  event: ReactPointerEvent<HTMLElement>
) {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  const target = event.target as Element;
  if (target.closest(NOT_EMPTY)) return;
  const host = target.closest<HTMLElement>('[data-col]');
  const col = columnOf(host);
  if (!host || col === undefined) return;
  const scroller = host.closest<HTMLElement>('[data-scroller]') ?? host;
  event.preventDefault();
  ctx.focusBrowser();

  const additive = event.ctrlKey || event.metaKey || event.shiftKey;
  // As a click range does, adding keeps to the column the selection is in.
  const base =
    additive && getSelection().cursor.col === col
      ? new Set(getSelection().keys)
      : new Set<ItemKey>();
  const startX = event.clientX;
  const startY = event.clientY;
  const scrollLeft = scroller.scrollLeft;
  const scrollTop = scroller.scrollTop;
  let active = false;
  let last: ItemKey | null = null;

  const move = (moved: PointerEvent) => {
    if (!active) {
      if (
        Math.abs(moved.clientX - startX) < THRESHOLD &&
        Math.abs(moved.clientY - startY) < THRESHOLD
      )
        return;
      active = true;
      document.body.classList.add(styles.selecting);
    }
    const bounds = scroller.getBoundingClientRect();
    const x = Math.min(bounds.right, Math.max(bounds.left, moved.clientX));
    const y = Math.min(bounds.bottom, Math.max(bounds.top, moved.clientY));
    // Where the press was now that the list has scrolled under it.
    const fromX = startX + scrollLeft - scroller.scrollLeft;
    const fromY = startY + scrollTop - scroller.scrollTop;
    const left = Math.min(fromX, x);
    const top = Math.min(fromY, y);
    const right = Math.max(fromX, x);
    const bottom = Math.max(fromY, y);
    const shownTop = Math.max(bounds.top, top);
    const shownBottom = Math.min(bounds.bottom, bottom);
    useMarqueeBox.setState({
      box: {
        left,
        top: shownTop,
        width: right - left,
        height: Math.max(0, shownBottom - shownTop),
      },
    });
    const hit = new Set(base);
    for (const item of host.querySelectorAll<HTMLElement>('[data-item]')) {
      const rect = item.getBoundingClientRect();
      const key = item.dataset.item;
      if (!(
        isItemKey(key) &&
        rect.right > left &&
        rect.left < right &&
        rect.bottom > top &&
        rect.top < bottom
      )) {
        continue;
      }

      hit.add(key);
      last = key;
    }
    setSelection({ keys: hit, cursor: { key: null, col }, anchor: null });
    if (moved.clientY < bounds.top + EDGE) scroller.scrollTop -= SCROLL_STEP;
    else if (moved.clientY > bounds.bottom - EDGE)
      scroller.scrollTop += SCROLL_STEP;
  };

  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    document.body.classList.remove(styles.selecting);
    useMarqueeBox.setState({ box: null });
    if (!active) {
      if (!additive) clearSelection(col);
      return;
    }
    const { keys } = getSelection();
    const ordered = [...keys];
    const cursor =
      last && keys.has(last) ? last : (ordered[ordered.length - 1] ?? null);
    select({ keys, cursor: { key: cursor, col }, anchor: ordered[0] ?? null });
  };

  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

export const Marquee = memo(() => {
  const box = useMarqueeBox((s) => s.box);
  const style = useMemo(
    () =>
      box && {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      },
    [box]
  );
  if (!style) return null;
  return (
    <div
      aria-hidden
      style={style}
      className='pointer-events-none fixed z-40 rounded-sm border border-primary bg-primary/15'
    />
  );
});

Marquee.displayName = 'Marquee';
