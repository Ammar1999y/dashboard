import type { ItemKey } from '@/lib/media/keys';
import type { CSSProperties } from 'react';

import { memo, useCallback, useMemo } from 'react';

import { useShallow } from 'zustand/shallow';
import {
  MSG_STATUS_ITEMS,
  MSG_STORAGE_FAILED,
  MSG_STORAGE_TOTALS,
} from '@/constants/messages';
import { filterCount } from '@/lib/media/listing';
import { useLibraryStats } from '@/lib/media/queries';
import { useSelection } from '@/lib/media/selection';
import { isActiveUpload, useUploads } from '@/lib/media/upload-queue';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { formatBytes } from '@/utils/format-bytes';

import { Icon } from '@/components/ui/icon';

import { useItems } from './items';
import { useResults } from './results';
import { currentFolder, isResults, useBrowser } from './store';
import { folderSource, useListing } from './use-listing';

const EMPTY: readonly ItemKey[] = [];

/** The folder whose count the bar gives: the column the cursor is in, or the current one. */
const useCountedFolder = () => {
  const col = useSelection((s) => s.cursor.col);
  return useBrowser((s) =>
    typeof col === 'number' && s.view === 'columns' && col < s.path.length
      ? (s.path[col] ?? null)
      : currentFolder(s.path)
  );
};

const FolderCount = memo(() => {
  const folder = useCountedFolder();
  const source = useMemo(() => folderSource(folder), [folder]);
  const { listing } = useListing(source, { enabled: false });
  return (
    <>
      {listing
        ? MSG_STATUS_ITEMS(listing.folders.length + listing.fileTotal)
        : '…'}
    </>
  );
});

FolderCount.displayName = 'FolderCount';

const ResultsCount = memo(() => {
  const { listing } = useResults();
  return (
    <>
      {listing
        ? MSG_STATUS_ITEMS(listing.folders.length + listing.fileTotal)
        : '…'}
    </>
  );
});

ResultsCount.displayName = 'ResultsCount';

const Selected = memo(() => {
  const selected = useSelection((s) => s.keys);
  const keys = useMemo(
    () => (selected.size > 0 ? [...selected] : EMPTY),
    [selected]
  );
  const items = useItems(keys);
  const size = items.reduce(
    (sum, item) => sum + (item?.kind === 'file' ? item.file.sizeBytes : 0),
    0
  );
  return (
    <>
      ، {keys.length} محدد
      {keys.length > 0 && (
        <>
          {' '}
          (
          <span dir='ltr' className='num bidi-isolate'>
            {formatBytes(size, 1)}
          </span>
          )
        </>
      )}
    </>
  );
});

Selected.displayName = 'Selected';

const UploadIndicator = memo(() => {
  const { total, done, failed, settled, active, open } = useUploads(
    useShallow((s) => ({
      total: s.items.length,
      done: s.items.filter(({ status }) => status === 'done').length,
      failed: s.items.filter(({ status }) => status === 'failed').length,
      settled: s.items.filter((item) => !isActiveUpload(item)).length,
      active: s.items.some(isActiveUpload),
      open: s.open,
    }))
  );
  const toggle = useCallback(
    () => useUploads.setState(({ open: current }) => ({ open: !current })),
    []
  );
  const percent = total === 0 ? 0 : Math.round((settled / total) * 100);
  const bar = useMemo(
    () => ({ width: `${percent}%` }) as CSSProperties,
    [percent]
  );

  let content;
  if (total === 0)
    content = (
      <>
        <Icon icon='lucide:upload' className='size-3.5' />
        <span>الرفع</span>
      </>
    );
  else if (active)
    content = (
      <>
        <Icon icon='lucide:loader-circle' className='size-3.5 animate-spin' />
        <span dir='ltr' className='num bidi-isolate'>
          {settled}/{total}
        </span>
        <span className='h-[3px] w-11 overflow-hidden rounded bg-border'>
          <i className='block h-full bg-primary' style={bar} />
        </span>
      </>
    );
  else
    content = (
      <>
        <Icon
          icon={failed > 0 ? 'lucide:triangle-alert' : 'lucide:circle-check'}
          className='size-3.5'
        />
        <span>{failed > 0 ? `${failed} فشل` : `اكتمل الرفع (${done})`}</span>
      </>
    );

  return (
    <button
      type='button'
      onClick={toggle}
      aria-haspopup='dialog'
      aria-expanded={open}
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-md border bg-muted px-2 text-xs text-muted-foreground hover:text-foreground',
        active && 'border-primary text-primary'
      )}
    >
      {content}
    </button>
  );
});

UploadIndicator.displayName = 'UploadIndicator';

/** What the whole library holds; a failed read is said, and asked again on a click. */
const Storage = memo(() => {
  const { data, error, isFetching, refetch } = useLibraryStats();
  const retry = useCallback(() => void refetch(), [refetch]);
  let content;
  if (data)
    content = (
      <span dir='ltr' className='num bidi-isolate'>
        {formatBytes(data.bytes, 1)}
      </span>
    );
  else if (error) content = <span>{MSG_STORAGE_FAILED}</span>;
  else content = <span>…</span>;
  return (
    <button
      type='button'
      onClick={retry}
      disabled={isFetching}
      title={
        data
          ? MSG_STORAGE_TOTALS(data.folders, data.files)
          : error
            ? errorMessage(error)
            : undefined
      }
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default group-data-[width=compact]/fm:hidden',
        !data && error && 'text-destructive'
      )}
    >
      <Icon
        icon={isFetching ? 'lucide:loader-circle' : 'lucide:hard-drive'}
        className={cn('size-3.5', isFetching && 'animate-spin')}
      />
      التخزين: {content}
    </button>
  );
});

Storage.displayName = 'Storage';

export const StatusBar = memo(() => {
  const results = useBrowser(isResults);
  const filters = useBrowser((s) => filterCount(s.filters));
  const busy = useBrowser((s) => s.busy > 0);
  return (
    <footer className='flex h-7 shrink-0 items-center gap-3.5 border-t bg-card px-3 text-xs text-muted-foreground group-data-[width=compact]/fm:gap-2'>
      <span className='inline-flex items-center gap-1.5 whitespace-nowrap'>
        {results ? <ResultsCount /> : <FolderCount />}
        <Selected />
        {filters > 0 && (
          <span className='text-primary'> · تصفية فعّالة ({filters})</span>
        )}
      </span>
      {busy && (
        <span className='inline-flex items-center gap-1.5 whitespace-nowrap'>
          <Icon icon='lucide:loader-circle' className='size-3.5 animate-spin' />
          جارٍ التنفيذ…
        </span>
      )}
      <span className='flex-1' />
      <Storage />
      <UploadIndicator />
    </footer>
  );
});

StatusBar.displayName = 'StatusBar';
