import type { MediaContext } from './context';
import type { MouseEvent, PointerEvent, RefObject } from 'react';

import { memo, useCallback } from 'react';

import { idOfKey, isFolderKey, isItemKey } from '@/lib/media/keys';
import { getSelection, only, setSelection } from '@/lib/media/selection';

import { ColumnsView } from './columns-view';
import { openQuickLook, readCommandState } from './commands';
import { useMedia } from './context';
import { GridView } from './grid-view';
import { SidePanel } from './inspector';
import { ListView } from './list-view';
import { columnOf, startMarquee } from './marquee';
import { anchorOf, openMenu } from './menu-store';
import {
  clearSelection,
  clickItem,
  enterFolder,
  toggleExpand,
} from './navigation';
import { isResults, useBrowser } from './store';

const itemOf = (target: EventTarget) =>
  target instanceof Element ? target.closest<HTMLElement>('[data-item]') : null;

/** Clicks anywhere in the views, handled once here rather than per row. */
function onClick(ctx: MediaContext, event: MouseEvent<HTMLElement>) {
  const target = event.target as Element;
  if (target.closest('input')) return;
  const element = itemOf(target);
  const key = element?.dataset.item;
  if (!element || !isItemKey(key)) return;
  const col = columnOf(element);
  if (col === undefined) return;

  const menu = target.closest('[data-menu]');
  if (menu) {
    if (!getSelection().keys.has(key))
      clickItem(ctx.queryClient, key, col, { toggle: false, range: false });
    openMenu('item', anchorOf(menu));
    return;
  }
  if (target.closest('[data-check]')) {
    clickItem(ctx.queryClient, key, col, { toggle: true, range: false });
    return;
  }
  if (target.closest('[data-disc]') && isFolderKey(key)) {
    toggleExpand(ctx.queryClient, idOfKey(key));
    return;
  }
  clickItem(ctx.queryClient, key, col, {
    toggle: event.ctrlKey || event.metaKey,
    range: event.shiftKey,
  });
}

function onDoubleClick(ctx: MediaContext, event: MouseEvent<HTMLElement>) {
  const target = event.target as Element;
  if (target.closest('input,[data-check],[data-menu],[data-disc]')) return;
  const key = itemOf(target)?.dataset.item;
  if (!isItemKey(key)) return;
  if (isFolderKey(key)) enterFolder(ctx.queryClient, idOfKey(key));
  else openQuickLook(ctx, readCommandState(ctx));
}

/**
 * The menu for what is under the pointer. A right-click selects without
 * opening a folder, so a pending paste keeps its place. Fields and the details
 * panel keep the browser's own menu.
 */
function onContextMenu(event: MouseEvent<HTMLElement>) {
  const target = event.target as Element;
  if (target.closest('input,textarea,aside')) return;
  event.preventDefault();
  // The keyboard's menu key fires this at the top left corner.
  const byKeyboard = event.clientX === 0 && event.clientY === 0;
  const element = itemOf(target);
  const key = element?.dataset.item;
  if (element && isItemKey(key)) {
    const col = columnOf(element);
    if (col !== undefined && !getSelection().keys.has(key))
      setSelection(only(key, col));
    openMenu(
      'item',
      byKeyboard
        ? anchorOf(element)
        : { x: event.clientX, y: event.clientY, width: 0, height: 0 }
    );
    return;
  }
  const col = columnOf(target);
  if (getSelection().keys.size > 0) clearSelection(col);
  openMenu(
    'empty',
    byKeyboard
      ? anchorOf(event.currentTarget)
      : { x: event.clientX, y: event.clientY, width: 0, height: 0 }
  );
}

interface BrowseProps {
  browseRef: RefObject<HTMLDivElement | null>;
}

/** The views and the details panel beside them, with their pointer handling. */
export const Browse = memo(({ browseRef }: BrowseProps) => {
  const ctx = useMedia();
  const view = useBrowser((s) =>
    isResults(s) && s.view === 'columns' ? 'list' : s.view
  );
  const results = useBrowser(isResults);
  const panel = useBrowser(
    (s) => s.inspector && (s.view !== 'columns' || isResults(s))
  );

  const click = useCallback(
    (event: MouseEvent<HTMLDivElement>) => onClick(ctx, event),
    [ctx]
  );
  const doubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => onDoubleClick(ctx, event),
    [ctx]
  );
  const pointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => startMarquee(ctx, event),
    [ctx]
  );

  let content;
  if (view === 'columns' && !results) content = <ColumnsView />;
  else if (view === 'grid') content = <GridView />;
  else content = <ListView />;

  return (
    <div
      ref={browseRef}
      tabIndex={0}
      role='region'
      aria-label='مستعرض الملفات'
      onClick={click}
      onDoubleClick={doubleClick}
      onContextMenu={onContextMenu}
      onPointerDown={pointerDown}
      className='group/browse relative flex min-h-0 min-w-0 flex-1 outline-none focus-visible:!ring-0'
    >
      {content}
      {panel && <SidePanel />}
    </div>
  );
});

Browse.displayName = 'Browse';
