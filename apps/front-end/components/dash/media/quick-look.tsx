import type { ItemKey } from '@/lib/media/keys';
import type { LibraryFile } from '@/lib/media/schemas';
import type { SelectionColumn } from '@/lib/media/selection';
import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from 'react';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  MSG_LOADING,
  MSG_PREVIEW_FAILED,
  MSG_RETRY,
} from '@/constants/messages';
import { hasInlinePreview } from '@/lib/media/schemas';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { useHeldWhileClosed } from '@/hooks/use-held-while-closed';
import { Button } from '@/components/ui/button';
import { DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { LabelTooltip } from '@/components/ui/tooltip';
import { StoreDialog } from '@/components/dialogs/store-dialog';

import { useMedia } from './context';
import { pdfPreviewDialog, quickLookDialog } from './dialogs';
import { downloadFiles } from './file-ops';
import { mimeLabel } from './format';
import { useItems } from './items';
import { selectOnly } from './navigation';
import { DocTile } from './thumb';
import { useImageSource } from './use-image-source';

const ZOOM = { min: 0.5, max: 8, step: 1.25, wheel: 1.15, click: 2.5 } as const;

interface View {
  zoom: number;
  x: number;
  y: number;
}

const AT_REST: View = { zoom: 1, x: 0, y: 0 };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const zoomed = (view: View, factor: number): View => {
  const zoom = clamp(view.zoom * factor, ZOOM.min, ZOOM.max);
  return zoom <= 1 ? { zoom, x: 0, y: 0 } : { ...view, zoom };
};

const barButton =
  'size-[30px] text-zinc-300 hover:bg-white/10 hover:text-white';

const DocumentStage = memo(({ file }: { file: LibraryFile }) => {
  const ctx = useMedia();
  const download = useCallback(
    () => void downloadFiles(ctx, [file.id]),
    [ctx, file.id]
  );
  const preview = useCallback(
    () => pdfPreviewDialog.open({ id: file.id }),
    [file.id]
  );
  return (
    <div className='flex flex-col items-center gap-2.5 p-8 text-center text-zinc-100'>
      <DocTile
        mimeType={file.mimeType}
        large
        className='h-[190px] w-[150px] rounded-xl shadow-lg'
      />
      <h3 className='mt-1.5 font-medium' dir='auto'>
        {file.displayName}
      </h3>
      <p className='text-zinc-400'>
        {mimeLabel(file.mimeType)} ·{' '}
        <span dir='ltr' className='num bidi-isolate'>
          {formatBytes(file.sizeBytes, 1)}
        </span>
      </p>
      <div className='mt-2.5 flex flex-wrap justify-center gap-2'>
        <Button onClick={download}>
          <Icon icon='lucide:download' className='size-4' />
          تنزيل
        </Button>
        {hasInlinePreview(file) && (
          <Button
            variant='outline'
            onClick={preview}
            className='border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white'
          >
            <Icon icon='lucide:eye' className='size-4' />
            معاينة
          </Button>
        )}
      </div>
    </div>
  );
});

DocumentStage.displayName = 'DocumentStage';

interface ImageStageProps {
  file: LibraryFile;
  view: View;
  onView: (update: (view: View) => View) => void;
}

const ImageStage = memo(({ file, view, onView }: ImageStageProps) => {
  const image = useImageSource(file);
  const style = useMemo<CSSProperties>(
    () => ({
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    }),
    [view]
  );

  // A click toggles the zoom; a drag on a zoomed image pans it.
  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLImageElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      const from = view;
      const move = (next: globalThis.PointerEvent) => {
        if (
          Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) >
          4
        )
          moved = true;
        if (moved && from.zoom > 1)
          onView(() => ({
            ...from,
            x: from.x + next.clientX - startX,
            y: from.y + next.clientY - startY,
          }));
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        if (!moved)
          onView((current) =>
            current.zoom > 1 ? AT_REST : { ...current, zoom: ZOOM.click }
          );
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    },
    [onView, view]
  );

  if (image.status === 'failed')
    return (
      <div className='flex flex-col items-center gap-2.5 text-zinc-100'>
        <Icon icon='lucide:triangle-alert' className='size-8 opacity-70' />
        <h3>{MSG_PREVIEW_FAILED}</h3>
        <Button
          variant='outline'
          onClick={image.retry}
          className='border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white'
        >
          <Icon icon='lucide:rotate-ccw' className='size-4' />
          {MSG_RETRY}
        </Button>
      </div>
    );
  return (
    <>
      {image.status !== 'loaded' && (
        <Icon
          icon='lucide:loader-circle'
          aria-label={MSG_LOADING}
          className='size-8 animate-spin text-zinc-300 [grid-area:1/1]'
        />
      )}
      {image.shown && (
        <img
          key={image.attempt}
          src={image.src}
          alt={file.displayName}
          draggable={false}
          onLoad={image.onLoad}
          onError={image.onError}
          onPointerDown={onPointerDown}
          style={style}
          className={cn(
            'max-h-full max-w-full select-none rounded-md object-contain shadow-2xl transition-transform duration-100 [grid-area:1/1]',
            image.status !== 'loaded' && 'opacity-0',
            view.zoom > 1 ? 'cursor-grab transition-none' : 'cursor-zoom-in'
          )}
        />
      )}
    </>
  );
});

ImageStage.displayName = 'ImageStage';

interface BodyProps {
  keys: readonly ItemKey[];
  start: number;
  col: SelectionColumn;
}

const QuickLookBody = memo(({ keys, start, col }: BodyProps) => {
  const ctx = useMedia();
  const live = useItems(keys);
  const open = quickLookDialog.useIsOpen();
  const items = useHeldWhileClosed(live, open);
  const [index, setIndex] = useState(start);
  const [view, setView] = useState<View>(AT_REST);
  const stage = useRef<HTMLDivElement>(null);
  const item = items[index];
  const file = item?.kind === 'file' ? item.file : undefined;

  const go = useCallback(
    (delta: number) => {
      const next = clamp(index + delta, 0, keys.length - 1);
      const key = keys[next];
      if (next === index || !key) return;
      setIndex(next);
      setView(AT_REST);
      if (keys.length > 1) selectOnly(key, col);
    },
    [index, keys, col]
  );
  const previous = useCallback(() => go(-1), [go]);
  const next = useCallback(() => go(1), [go]);
  const zoomIn = useCallback(
    () => setView((current) => zoomed(current, ZOOM.step)),
    []
  );
  const zoomOut = useCallback(
    () => setView((current) => zoomed(current, 1 / ZOOM.step)),
    []
  );
  const reset = useCallback(() => setView(AT_REST), []);
  const download = useCallback(() => {
    if (file) void downloadFiles(ctx, [file.id]);
  }, [ctx, file]);

  // Not React's wheel handler: it is passive and cannot keep the page still.
  const isImage = file?.kind === 'image';
  useEffect(() => {
    const element = stage.current;
    if (!element || !isImage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((current) =>
        zoomed(current, event.deltaY < 0 ? ZOOM.wheel : 1 / ZOOM.wheel)
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [isImage]);

  // Right to left, ArrowLeft goes to the next file.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const actions: Readonly<Record<string, () => void>> = {
        ArrowLeft: next,
        ArrowRight: previous,
        '+': zoomIn,
        '=': zoomIn,
        '-': zoomOut,
        '0': reset,
        ' ': quickLookDialog.close,
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    },
    [next, previous, zoomIn, zoomOut, reset]
  );

  const closeOnBackdrop = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) quickLookDialog.close();
  }, []);

  // Deleted or moved out of every listing elsewhere: nothing is left to show.
  const gone = live[index]?.kind !== 'file';
  useEffect(() => {
    if (gone) quickLookDialog.close();
  }, [gone]);

  if (!file) return null;
  return (
    <div className='flex h-full min-h-0 flex-col' onKeyDown={onKeyDown}>
      <div className='relative z-[2] flex items-center justify-between gap-3 px-4 py-2.5 text-zinc-100'>
        <div className='flex min-w-0 flex-wrap items-center gap-2.5'>
          <DialogTitle
            className='max-w-[46vw] truncate font-medium text-zinc-100'
            dir='auto'
          >
            {file.displayName}
          </DialogTitle>
          <span className='text-xs text-zinc-400'>
            {mimeLabel(file.mimeType)} ·{' '}
            <span dir='ltr' className='num bidi-isolate'>
              {formatBytes(file.sizeBytes, 1)}
              {file.width !== null &&
                file.height !== null &&
                ` · ${file.width} × ${file.height}`}
            </span>
          </span>
          <span dir='ltr' className='num bidi-isolate text-xs text-zinc-400'>
            {index + 1} / {keys.length}
          </span>
        </div>
        <div className='flex items-center gap-1'>
          {isImage && (
            <>
              <LabelTooltip label='تصغير (-)'>
                <Button
                  variant='ghost'
                  size='none'
                  className={barButton}
                  onClick={zoomOut}
                >
                  <Icon icon='lucide:zoom-out' className='size-4' />
                </Button>
              </LabelTooltip>
              <button
                type='button'
                onClick={reset}
                className='h-7 min-w-12 rounded-md font-mono text-xs text-zinc-300 hover:bg-white/10'
              >
                {Math.round(view.zoom * 100)}%
              </button>
              <LabelTooltip label='تكبير (+)'>
                <Button
                  variant='ghost'
                  size='none'
                  className={barButton}
                  onClick={zoomIn}
                >
                  <Icon icon='lucide:zoom-in' className='size-4' />
                </Button>
              </LabelTooltip>
            </>
          )}
          <LabelTooltip label='تنزيل'>
            <Button
              variant='ghost'
              size='none'
              className={barButton}
              onClick={download}
            >
              <Icon icon='lucide:download' className='size-4' />
            </Button>
          </LabelTooltip>
          <LabelTooltip label='إغلاق (Esc)'>
            <Button
              variant='ghost'
              size='none'
              className={barButton}
              onClick={quickLookDialog.close}
            >
              <Icon icon='lucide:x' className='size-4' />
            </Button>
          </LabelTooltip>
        </div>
      </div>
      {keys.length > 1 && (
        <>
          <button
            type='button'
            aria-label='السابق'
            onClick={previous}
            disabled={index === 0}
            className='absolute top-1/2 z-[3] grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-zinc-900/70 text-white hover:bg-primary disabled:pointer-events-none disabled:opacity-25 ltr:left-3.5 rtl:right-3.5'
          >
            <Icon
              icon='lucide:chevron-right'
              className='size-5 ltr:rotate-180'
            />
          </button>
          <button
            type='button'
            aria-label='التالي'
            onClick={next}
            disabled={index === keys.length - 1}
            className='absolute top-1/2 z-[3] grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-zinc-900/70 text-white hover:bg-primary disabled:pointer-events-none disabled:opacity-25 ltr:right-3.5 rtl:left-3.5'
          >
            <Icon
              icon='lucide:chevron-left'
              className='size-5 ltr:rotate-180'
            />
          </button>
        </>
      )}
      <div
        ref={stage}
        onClick={closeOnBackdrop}
        className='grid min-h-0 flex-1 place-items-center overflow-hidden px-[70px] pb-6'
      >
        {isImage ? (
          <ImageStage key={file.id} file={file} view={view} onView={setView} />
        ) : (
          <DocumentStage file={file} />
        )}
      </div>
    </div>
  );
});

QuickLookBody.displayName = 'QuickLookBody';

/** The files of one list, one at a time, over the whole screen. */
export const QuickLook = memo(() => {
  const request = quickLookDialog.usePayload();
  return (
    <StoreDialog
      dialog={quickLookDialog}
      side='full'
      overlayClassName='bg-black/90 backdrop-blur-md'
      className='block gap-0 border-0 bg-transparent p-0 shadow-none'
    >
      {request && (
        <QuickLookBody
          key={`${request.keys.join(',')}:${request.index}`}
          keys={request.keys}
          start={request.index}
          col={request.col}
        />
      )}
    </StoreDialog>
  );
});

QuickLook.displayName = 'QuickLook';
