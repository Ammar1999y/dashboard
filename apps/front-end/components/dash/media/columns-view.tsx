import type { EntityID } from '@app/shared/types';
import type { CSSProperties, PointerEvent } from 'react';

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LIBRARY_ROOT, MSG_STATUS_ITEMS } from '@/constants/messages';
import { hasErrorStatus } from '@/lib/api/fetch';
import { isFolderKey } from '@/lib/media/keys';
import { useSelection } from '@/lib/media/selection';
import { cn } from '@/lib/utils';

import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';

import { FileRow, FolderRow, SkeletonRows } from './column-row';
import { useMedia } from './context';
import { Inspector } from './inspector';
import styles from './media.module.css';
import { focusColumn } from './navigation';
import { NewFolderRow, useIsNamingIn } from './new-folder';
import { FolderEmpty, LoadMore } from './states';
import {
  COLUMN_WIDTH_RANGE,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_INSPECTOR_WIDTH,
  getBrowser,
  setPath,
  useBrowser,
} from './store';
import { folderSource, useListing } from './use-listing';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Drags a column's edge. Right to left, the column grows as the pointer moves
 * left, away from where the column starts.
 */
function useResize(widthKey: string) {
  return useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const column = event.currentTarget.parentElement;
      if (!column) return;
      const startWidth = column.offsetWidth;
      const startX = event.clientX;
      const rtl = getComputedStyle(column).direction === 'rtl';
      document.body.classList.add(styles.resizing);
      const move = (moved: globalThis.PointerEvent) => {
        const delta = rtl ? startX - moved.clientX : moved.clientX - startX;
        const width = clamp(
          startWidth + delta,
          COLUMN_WIDTH_RANGE.min,
          COLUMN_WIDTH_RANGE.max
        );
        useBrowser.setState(({ widths }) => ({
          widths: { ...widths, [widthKey]: width },
        }));
      };
      const up = () => {
        document.body.classList.remove(styles.resizing);
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    },
    [widthKey]
  );
}

/** Its default width back on a double click. */
function useResetWidth(widthKey: string) {
  return useCallback(() => {
    useBrowser.setState(({ widths }) => {
      const { [widthKey]: _, ...rest } = widths;
      return { widths: rest };
    });
  }, [widthKey]);
}

const Resizer = memo(({ widthKey }: { widthKey: string }) => {
  const onPointerDown = useResize(widthKey);
  const onDoubleClick = useResetWidth(widthKey);
  return (
    <span
      aria-hidden
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className='group/rz absolute inset-y-0 z-[5] w-2 cursor-col-resize group-data-[width=compact]/fm:hidden ltr:-right-1 rtl:-left-1'
    >
      <span className='absolute inset-y-0 w-0.5 bg-transparent transition-colors group-hover/rz:bg-primary ltr:right-[3px] rtl:left-[3px]' />
    </span>
  );
});

Resizer.displayName = 'Resizer';

const widthStyle = (width: number): CSSProperties =>
  ({ '--w': `${width}px` }) as CSSProperties;

const columnClass =
  'group/col relative flex w-[--w] shrink-0 flex-col border-e bg-background group-data-[width=compact]/fm:w-[86vw] group-data-[width=compact]/fm:snap-start';

const Column = memo(
  ({ index, folder }: { index: number; folder: EntityID | null }) => {
    const ctx = useMedia();
    const source = useMemo(() => folderSource(folder), [folder]);
    const {
      listing,
      error,
      refetch,
      fetchNextPage,
      hasNextPage,
      isFetchingNextPage,
      nextPageError,
    } = useListing(source);
    const active = useSelection((s) => s.cursor.col === index);
    const openChild = useBrowser((s) => s.path[index + 1]);
    const width = useBrowser(
      (s) => s.widths[String(index)] ?? DEFAULT_COLUMN_WIDTH
    );
    const naming = useIsNamingIn(folder);
    const pendingFocus = useBrowser((s) => s.pendingFocus === index);
    const style = useMemo(() => widthStyle(width), [width]);

    // A folder gone since it was opened closes, with the columns after it.
    const gone = !!error && hasErrorStatus(error, HTTP_STATUS.NOT_FOUND);
    useEffect(() => {
      if (!gone || folder === null) return;
      const { path } = getBrowser();
      if (path[index] === folder) setPath(path.slice(0, index));
    }, [gone, folder, index]);

    useEffect(() => {
      if (pendingFocus && listing) focusColumn(ctx.queryClient, index);
    }, [pendingFocus, listing, ctx.queryClient, index]);

    const name =
      index === 0
        ? MSG_LIBRARY_ROOT
        : (listing?.breadcrumbs?.[listing.breadcrumbs.length - 1]?.name ?? '…');
    const empty =
      listing && listing.folders.length === 0 && listing.files.length === 0;

    let body;
    if (error && !listing)
      body = (
        <ErrorState
          error={error}
          refetch={refetch}
          className='m-2 py-6 text-sm'
        />
      );
    else if (listing) {
      body = (
        <>
          {naming && <NewFolderRow />}
          {listing.folders.map((child) => (
            <FolderRow
              key={child.id}
              folder={child}
              open={openChild === child.id}
            />
          ))}
          {listing.files.map((file) => (
            <FileRow key={file.id} file={file} />
          ))}
          {empty && !naming && <FolderEmpty folder={folder} />}
          {hasNextPage && (
            <LoadMore
              remaining={listing.fileTotal - listing.files.length}
              loading={isFetchingNextPage}
              error={nextPageError}
              onLoad={fetchNextPage}
            />
          )}
        </>
      );
    } else {
      body = <SkeletonRows />;
    }

    return (
      <section
        className={columnClass}
        style={style}
        data-active={active}
        data-dz={folder ?? 'root'}
        aria-label={name}
      >
        <header className='flex h-7 shrink-0 items-center justify-between gap-1.5 border-b px-2.5 text-xs text-muted-foreground'>
          <span className='flex min-w-0 items-center gap-1.5'>
            <Icon
              icon={index === 0 ? 'lucide:house' : 'lucide:folder-open'}
              className='size-3.5 shrink-0'
            />
            <b className='truncate font-medium text-foreground' dir='auto'>
              {name}
            </b>
          </span>
          {listing && (
            <span className='shrink-0'>
              {MSG_STATUS_ITEMS(listing.folders.length + listing.fileTotal)}
            </span>
          )}
        </header>
        <div
          role='listbox'
          aria-multiselectable
          aria-label={name}
          data-col={index}
          data-scroller
          className='relative flex-1 overflow-y-auto overflow-x-hidden p-1'
        >
          {body}
        </div>
        <Resizer widthKey={String(index)} />
      </section>
    );
  }
);

Column.displayName = 'Column';

/** In the column view the details are one more column, for files or several items. */
const useInspectorColumn = () =>
  useSelection(
    (s) => s.keys.size > 1 || [...s.keys].some((key) => !isFolderKey(key))
  );

const InspectorColumn = memo(() => {
  const width = useBrowser(
    (s) => s.widths.inspector ?? DEFAULT_INSPECTOR_WIDTH
  );
  const style = useMemo(() => widthStyle(width), [width]);
  return (
    <aside
      className={cn(
        'relative w-[--w] shrink-0 border-e bg-card group-data-[width=compact]/fm:w-[92vw] group-data-[width=compact]/fm:snap-start',
        styles.pop
      )}
      style={style}
      aria-label='التفاصيل'
    >
      <div className='h-full overflow-y-auto'>
        <Inspector />
      </div>
      <Resizer widthKey='inspector' />
    </aside>
  );
});

InspectorColumn.displayName = 'InspectorColumn';

export const ColumnsView = memo(() => {
  const path = useBrowser((s) => s.path);
  const inspector = useBrowser((s) => s.inspector);
  const wanted = useInspectorColumn();
  const strip = useRef<HTMLDivElement>(null);
  const showInspector = inspector && wanted;
  const count = path.length + (showInspector ? 1 : 0);

  // A column added comes into view, as Finder scrolls to it.
  useEffect(() => {
    const last = strip.current?.lastElementChild;
    if (!last) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    last.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [count]);

  return (
    <div
      ref={strip}
      className='flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden group-data-[width=compact]/fm:snap-x group-data-[width=compact]/fm:snap-proximity'
    >
      {path.map((folder, index) => (
        <Column
          key={`${index}:${folder ?? 'root'}`}
          index={index}
          folder={folder}
        />
      ))}
      {showInspector && <InspectorColumn />}
    </div>
  );
});

ColumnsView.displayName = 'ColumnsView';
