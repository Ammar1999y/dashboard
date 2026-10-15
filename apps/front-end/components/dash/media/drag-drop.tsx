import type { MediaContext } from './context';
import type { ItemKey } from '@/lib/media/keys';
import type { EntityID } from '@app/shared/types';
import type { DragEvent } from 'react';

import { memo, useMemo, useRef } from 'react';

import { create } from 'zustand';
import {
  MSG_DROP_INTO,
  MSG_DROP_PICKS_FOLDER,
  MSG_DROP_TO_UPLOAD,
  MSG_LIBRARY_ROOT,
  MSG_MOVE_TO,
} from '@/constants/messages';
import { folderKey, isItemKey } from '@/lib/media/keys';
import { getSelection } from '@/lib/media/selection';
import { cn } from '@/lib/utils';

import { useHeldWhileClosed } from '@/hooks/use-held-while-closed';
import { Icon } from '@/components/ui/icon';

import { moveVerdict } from './clip';
import { findItem, itemName, itemParent } from './items';
import { columnOf } from './marquee';
import styles from './media.module.css';
import { clickItem, folderName, goTo, toggleExpand } from './navigation';
import { dropMove, flash, targetTrail } from './operations';
import { currentFolder, getBrowser, isResults, setPath } from './store';
import { uploadDropped } from './upload-ops';

/** The type an internal drag carries, so a drop can tell it from files. */
const DRAG_TYPE = 'application/x-media-items';
/** Holding a drag over a folder this long opens it. */
const SPRING_MS = 700;
/** The upload veil fades when no dragover has refreshed it for this long. */
const VEIL_MS = 1200;

interface DragUi {
  /** The upload veil's label while files from the desktop are over the library. */
  veil: string | null;
  hint: { text: string; bad: boolean; x: number; y: number } | null;
}

const useDragUi = create<DragUi>(() => ({ veil: null, hint: null }));

const hasType = (event: DragEvent, type: string) =>
  [...(event.dataTransfer?.types ?? [])].includes(type);

/** `root` stands for the library's root, whose id is `null`. */
const targetOf = (value: string | undefined): EntityID | null | undefined =>
  value === undefined ? undefined : value === 'root' ? null : value;

/** Drags of items to move them, and of files from the desktop to upload them. */
export function useDragAndDrop(ctx: MediaContext) {
  const drag = useRef<readonly ItemKey[] | null>(null);
  const zone = useRef<HTMLElement | null>(null);
  const spring = useRef<ReturnType<typeof setTimeout> | null>(null);
  const veilTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useMemo(() => {
    const clearZone = () => {
      if (zone.current) delete zone.current.dataset.drop;
      zone.current = null;
      if (spring.current) clearTimeout(spring.current);
      spring.current = null;
    };

    const end = () => {
      drag.current = null;
      clearZone();
      if (veilTimer.current) clearTimeout(veilTimer.current);
      useDragUi.setState({ veil: null, hint: null });
    };

    const entriesOf = (keys: readonly ItemKey[]) =>
      keys.flatMap((key) => {
        const item = findItem(ctx.queryClient, key);
        return item
          ? [{ key, parent: itemParent(item), name: itemName(item) }]
          : [];
      });

    const judge = (target: EntityID | null | undefined) =>
      target === undefined || !drag.current
        ? null
        : moveVerdict(
            entriesOf(drag.current),
            target,
            targetTrail(ctx, target),
            { partialAtRoot: false }
          );

    /** Opens the folder held under a drag, as Finder springs one open. */
    const springOpen = (element: HTMLElement, folder: EntityID) => {
      if (!element.isConnected) return;
      element.classList.add(styles.sprung);
      const col = columnOf(element);
      const state = getBrowser();
      if (
        typeof col === 'number' &&
        state.view === 'columns' &&
        !isResults(state)
      )
        setPath([...state.path.slice(0, col + 1), folder]);
      else if (col === 'list') toggleExpand(ctx.queryClient, folder, true);
      else goTo(ctx.queryClient, folder);
    };

    const onDragStart = (event: DragEvent<HTMLElement>) => {
      const element = (event.target as Element).closest<HTMLElement>(
        '[data-item][draggable=true]'
      );
      const key = element?.dataset.item;
      if (!element || !isItemKey(key)) {
        // An image dragged out of a row would start the browser's own drag.
        if ((event.target as Element).tagName === 'IMG') event.preventDefault();
        return;
      }
      const col = columnOf(element);
      if (col !== undefined && !getSelection().keys.has(key))
        clickItem(ctx.queryClient, key, col, { toggle: false, range: false });
      const keys = [...getSelection().keys];
      drag.current = keys;
      const names = keys.map((one) => {
        const item = findItem(ctx.queryClient, one);
        return item ? itemName(item) : '';
      });
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_TYPE, keys.join(','));
      event.dataTransfer.setData('text/plain', names.join('\n'));

      const ghost = document.createElement('div');
      ghost.className = cn(
        'fixed -top-52 inline-flex max-w-56 items-center gap-2 rounded-lg bg-primary py-1.5 pe-3 ps-2 text-xs font-medium text-primary-foreground shadow-lg rtl:-right-96 ltr:-left-96',
        keys.length > 1 && styles.ghostMulti
      );
      const count = document.createElement('span');
      count.className =
        'grid h-5 min-w-5 place-items-center rounded-full bg-primary-foreground px-1 font-mono text-xs text-primary';
      count.textContent = String(keys.length);
      const name = document.createElement('span');
      name.className = 'truncate';
      name.textContent = names[keys.indexOf(key)] ?? '';
      ghost.append(count, name);
      document.body.append(ghost);
      event.dataTransfer.setDragImage(ghost, 14, 14);
      setTimeout(() => ghost.remove(), 0);
    };

    const onDragOver = (event: DragEvent<HTMLElement>) => {
      const internal = !!drag.current && hasType(event, DRAG_TYPE);
      const external = !internal && hasType(event, 'Files');
      if (!internal && !external) return;
      const element = (event.target as Element).closest<HTMLElement>(
        '[data-dz]'
      );
      const target = targetOf(element?.dataset.dz);

      if (external) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        const into =
          target === undefined ? currentFolder(getBrowser().path) : target;
        useDragUi.setState({
          veil:
            into === null
              ? MSG_DROP_PICKS_FOLDER
              : MSG_DROP_INTO(folderName(ctx.queryClient, into) ?? '…'),
        });
        if (veilTimer.current) clearTimeout(veilTimer.current);
        veilTimer.current = setTimeout(
          () => useDragUi.setState({ veil: null }),
          VEIL_MS
        );
        return;
      }

      const verdict = judge(target);
      const ok = verdict?.ok === true;
      if (ok) event.preventDefault();
      event.dataTransfer.dropEffect = ok ? 'move' : 'none';
      const soft = verdict !== null && !verdict.ok && verdict.soft === true;

      if (element !== zone.current) {
        clearZone();
        if (element && target !== undefined) {
          zone.current = element;
          if (ok || !soft) element.dataset.drop = ok ? 'ok' : 'bad';
          if (ok && target !== null && element.dataset.item)
            spring.current = setTimeout(
              () => springOpen(element, target),
              SPRING_MS
            );
        }
      }

      let text = '';
      if (target !== undefined && drag.current && verdict?.ok)
        text = MSG_MOVE_TO(
          drag.current.length,
          target === null
            ? MSG_LIBRARY_ROOT
            : (folderName(ctx.queryClient, target) ?? '…')
        );
      else if (verdict && !verdict.ok) text = verdict.reason;
      useDragUi.setState({
        hint: text
          ? { text, bad: !ok, x: event.clientX, y: event.clientY }
          : null,
      });
    };

    const onDragLeave = (event: DragEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      clearZone();
      useDragUi.setState({ veil: null, hint: null });
    };

    const onDrop = (event: DragEvent<HTMLElement>) => {
      const internal = !!drag.current && hasType(event, DRAG_TYPE);
      const external = !internal && hasType(event, 'Files');
      if (!internal && !external) return;
      event.preventDefault();
      const element = (event.target as Element).closest<HTMLElement>(
        '[data-dz]'
      );
      const target = targetOf(element?.dataset.dz);
      if (external) {
        void uploadDropped(ctx, event.dataTransfer, target);
        end();
        return;
      }
      const keys = drag.current;
      const verdict = judge(target);
      end();
      if (!keys || target === undefined || !verdict || !verdict.ok) return;
      void dropMove(ctx, keys, target).then(() => {
        if (target !== null) flash(folderKey(target));
      });
    };

    return { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd: end };
  }, [ctx]);
}

/** The upload veil and the hint that follows a drag. */
export const DragOverlays = memo(() => {
  const veil = useDragUi((s) => s.veil);
  // The veil fades out over its transition; its label stays while it does.
  const label = useHeldWhileClosed(veil, veil !== null);
  const hint = useDragUi((s) => s.hint);
  const hintStyle = useMemo(
    () =>
      hint && {
        transform: `translate(${Math.min(hint.x + 16, innerWidth - 340)}px, ${Math.min(hint.y + 18, innerHeight - 40)}px)`,
      },
    [hint]
  );
  return (
    <>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none fixed inset-0 z-50 grid place-items-center bg-primary/15 opacity-0 transition-opacity',
          veil && 'opacity-100',
          styles.dropFrame
        )}
      >
        <div className='flex flex-col items-center gap-1.5 rounded-2xl border border-primary bg-card px-8 py-5 shadow-lg'>
          <Icon icon='lucide:file-up' className='size-8 text-primary' />
          <b>{MSG_DROP_TO_UPLOAD}</b>
          <span className='text-xs text-muted-foreground'>{label}</span>
        </div>
      </div>
      {hint && hintStyle && (
        <div
          aria-hidden
          style={hintStyle}
          className={cn(
            'pointer-events-none fixed top-0 z-50 max-w-80 rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground shadow-lg ltr:left-0 rtl:left-0',
            hint.bad && 'bg-destructive text-white'
          )}
        >
          {hint.text}
        </div>
      )}
    </>
  );
});

DragOverlays.displayName = 'DragOverlays';
