import type { IconName } from '@/components/ui/icon';
import type { EntityID } from '@app/shared/types';
import type { ReactNode } from 'react';

import { memo, useCallback, useEffect, useRef } from 'react';

import { useShallow } from 'zustand/shallow';
import {
  MSG_EMPTY_FILTERED,
  MSG_EMPTY_FOLDER,
  MSG_EMPTY_LIBRARY,
  MSG_EMPTY_ROOT,
  MSG_EMPTY_SEARCH,
  MSG_EMPTY_SEARCH_FILTERED,
  MSG_LOAD_MORE,
  MSG_NO_RESULTS,
  MSG_RETRY,
  MSG_SEARCH_DIRECT_ONLY,
  MSG_UNFILED_NOTICE,
} from '@/constants/messages';
import { filterCount, NO_FILTERS } from '@/lib/media/listing';
import { errorMessage } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { useMedia } from './context';
import { clearSearch, setFilters, setMode } from './navigation';
import { startNewFolder } from './operations';
import { useBrowser } from './store';

type Illustration = 'folder' | 'root' | 'search';

const ILLUSTRATIONS: Readonly<Record<Illustration, ReactNode>> = {
  folder: (
    <>
      <rect
        x='22'
        y='26'
        width='116'
        height='70'
        rx='10'
        className='fill-muted stroke-border'
      />
      <path
        d='M22 38a10 10 0 0 1 10-10h28l10 10h58a10 10 0 0 1 10 10v8H22z'
        strokeDasharray='4 4'
        className='fill-primary/15 stroke-primary'
      />
      <circle cx='118' cy='30' r='14' className='fill-primary' />
      <path
        d='M118 24v12M112 30h12'
        strokeWidth='2.4'
        strokeLinecap='round'
        className='stroke-primary-foreground'
      />
    </>
  ),
  root: (
    <>
      <rect
        x='20'
        y='40'
        width='54'
        height='42'
        rx='8'
        className='fill-muted stroke-border'
      />
      <rect
        x='86'
        y='40'
        width='54'
        height='42'
        rx='8'
        strokeDasharray='4 4'
        className='fill-primary/15 stroke-primary'
      />
      <rect
        x='53'
        y='18'
        width='54'
        height='42'
        rx='8'
        className='fill-card stroke-border'
      />
      <path
        d='M80 31v16M72 39h16'
        strokeWidth='2.6'
        strokeLinecap='round'
        className='stroke-primary'
      />
    </>
  ),
  search: (
    <>
      <circle
        cx='72'
        cy='50'
        r='30'
        strokeWidth='2'
        className='fill-muted stroke-border'
      />
      <circle
        cx='72'
        cy='50'
        r='30'
        fill='none'
        strokeWidth='3'
        strokeDasharray='6 6'
        className='stroke-primary'
      />
      <path
        d='M95 73l24 24'
        strokeWidth='6'
        strokeLinecap='round'
        className='stroke-primary'
      />
      <path
        d='M60 50h24'
        strokeWidth='3'
        strokeLinecap='round'
        className='stroke-muted-foreground/60'
      />
    </>
  ),
};

type EmptyAction =
  'upload' | 'newfolder' | 'clearsearch' | 'clearfilters' | 'viewfolders';

const ACTIONS: Readonly<
  Record<EmptyAction, { label: string; icon: IconName; primary?: boolean }>
> = {
  upload: { label: 'رفع ملفات', icon: 'lucide:upload', primary: true },
  newfolder: { label: 'مجلد جديد', icon: 'lucide:folder-plus' },
  clearsearch: { label: 'مسح البحث', icon: 'lucide:x' },
  clearfilters: { label: 'إزالة التصفية', icon: 'lucide:list-filter' },
  viewfolders: {
    label: 'العودة إلى المجلدات',
    icon: 'lucide:folder-open',
    primary: true,
  },
};

const EmptyButton = memo(({ action }: { action: EmptyAction }) => {
  const ctx = useMedia();
  const run = useCallback(() => {
    if (action === 'upload') ctx.pickFiles({});
    else if (action === 'newfolder') startNewFolder(ctx);
    else if (action === 'clearsearch') clearSearch();
    else if (action === 'clearfilters') setFilters(NO_FILTERS);
    else setMode('folders');
  }, [action, ctx]);
  const { label, icon, primary } = ACTIONS[action];
  if ((action === 'upload' || action === 'newfolder') && !ctx.access.canCreate)
    return null;
  return (
    <Button size='sm' variant={primary ? 'default' : 'outline'} onClick={run}>
      <Icon icon={icon} className='size-4' />
      {label}
    </Button>
  );
});

EmptyButton.displayName = 'EmptyButton';

interface EmptyStateProps {
  illustration: Illustration;
  title: string;
  text: string;
  actions: readonly EmptyAction[];
}

const EmptyState = memo(
  ({ illustration, title, text, actions }: EmptyStateProps) => (
    <div
      data-no-marquee
      className='flex flex-col items-center gap-1.5 px-4 py-9 text-center text-muted-foreground'
    >
      <svg viewBox='0 0 160 110' aria-hidden className='mb-1 h-auto w-32'>
        {ILLUSTRATIONS[illustration]}
      </svg>
      <h4 className='mt-1 text-sm font-medium text-foreground'>{title}</h4>
      <p className='max-w-72 text-xs'>{text}</p>
      {actions.length > 0 && (
        <div className='mt-2.5 flex flex-wrap justify-center gap-2'>
          {actions.map((action) => (
            <EmptyButton key={action} action={action} />
          ))}
        </div>
      )}
    </div>
  )
);

EmptyState.displayName = 'EmptyState';

const useFiltered = () => useBrowser((s) => filterCount(s.filters) > 0);

/** An empty folder of the tree: the root, one with nothing, or one the filters empty. */
export const FolderEmpty = memo(({ folder }: { folder: EntityID | null }) => {
  const filtered = useFiltered();
  if (folder === null)
    return (
      <EmptyState
        illustration='root'
        title='لا توجد مجلدات بعد'
        text={MSG_EMPTY_ROOT}
        actions={ROOT_ACTIONS}
      />
    );
  if (filtered)
    return (
      <EmptyState
        illustration='search'
        title='لا توجد ملفات تطابق التصفية'
        text={MSG_EMPTY_FILTERED}
        actions={FILTER_ACTIONS}
      />
    );
  return (
    <EmptyState
      illustration='folder'
      title='هذا المجلد فارغ'
      text={MSG_EMPTY_FOLDER}
      actions={FOLDER_ACTIONS}
    />
  );
});

FolderEmpty.displayName = 'FolderEmpty';

const ROOT_ACTIONS: readonly EmptyAction[] = ['newfolder'];
const FILTER_ACTIONS: readonly EmptyAction[] = ['clearfilters'];
const FOLDER_ACTIONS: readonly EmptyAction[] = ['upload', 'newfolder'];
const SEARCH_ACTIONS: readonly EmptyAction[] = ['clearsearch'];
const SEARCH_FILTERED_ACTIONS: readonly EmptyAction[] = [
  'clearsearch',
  'clearfilters',
];
const ALL_ACTIONS: readonly EmptyAction[] = ['viewfolders'];

/** Results with nothing in them, said for what was asked. */
export const ResultsEmpty = memo(
  ({ retentionDays }: { retentionDays: number | undefined }) => {
    const filtered = useFiltered();
    const { query, queryFolder, mode } = useBrowser(
      useShallow((s) => ({
        query: s.query,
        queryFolder: s.queryFolder,
        mode: s.mode,
      }))
    );
    if (query) {
      let text = MSG_EMPTY_SEARCH;
      if (filtered) text = MSG_EMPTY_SEARCH_FILTERED;
      else if (queryFolder !== null) text = MSG_SEARCH_DIRECT_ONLY;
      return (
        <EmptyState
          illustration='search'
          title={MSG_NO_RESULTS}
          text={text}
          actions={filtered ? SEARCH_FILTERED_ACTIONS : SEARCH_ACTIONS}
        />
      );
    }
    if (filtered)
      return (
        <EmptyState
          illustration='search'
          title='لا توجد ملفات تطابق التصفية'
          text={MSG_EMPTY_FILTERED}
          actions={FILTER_ACTIONS}
        />
      );
    if (mode === 'unfiled')
      return (
        <EmptyState
          illustration='search'
          title='لا توجد ملفات غير مصنّفة'
          text={
            retentionDays === undefined ? '' : MSG_UNFILED_NOTICE(retentionDays)
          }
          actions={ALL_ACTIONS}
        />
      );
    return (
      <EmptyState
        illustration='search'
        title='لا توجد ملفات في المكتبة'
        text={MSG_EMPTY_LIBRARY}
        actions={ALL_ACTIONS}
      />
    );
  }
);

ResultsEmpty.displayName = 'ResultsEmpty';

interface LoadMoreProps {
  remaining: number;
  loading: boolean;
  /** Why the last page did not load; it is then asked for only by hand. */
  error: Error | null;
  onLoad: () => void;
  className?: string;
}

/**
 * The end of a listing with more to fetch: it loads the next page when it
 * scrolls into view, and offers a button for when it does not.
 */
export const LoadMore = memo(
  ({ remaining, loading, error, onLoad, className }: LoadMoreProps) => {
    const sentinel = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const element = sentinel.current;
      if (!element || loading || error) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) onLoad();
        },
        { rootMargin: '240px' }
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, [loading, error, onLoad]);

    return (
      <div
        ref={sentinel}
        data-no-marquee
        className={cn(
          'flex items-center justify-center gap-1.5 p-2.5 text-xs text-muted-foreground',
          className
        )}
      >
        {loading && (
          <>
            <Icon icon='lucide:loader-circle' className='size-4 animate-spin' />
            جارٍ التحميل…
          </>
        )}
        {!loading && error && (
          <>
            <Icon
              icon='lucide:triangle-alert'
              className='size-4 text-destructive'
            />
            <span className='text-destructive'>{errorMessage(error)}</span>
            <Button
              variant='link'
              size='none'
              className='text-xs'
              onClick={onLoad}
            >
              {MSG_RETRY}
            </Button>
          </>
        )}
        {!loading && !error && (
          <Button
            variant='link'
            size='none'
            className='text-xs'
            onClick={onLoad}
          >
            {MSG_LOAD_MORE(remaining)}
          </Button>
        )}
      </div>
    );
  }
);

LoadMore.displayName = 'LoadMore';
