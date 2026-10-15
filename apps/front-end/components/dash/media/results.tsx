import type { Listing } from './use-listing';

import { memo, useCallback, useMemo } from 'react';

import { useShallow } from 'zustand/shallow';
import {
  MSG_FOLDERS_TRUNCATED,
  MSG_RESULTS_EVERYWHERE,
  MSG_RESULTS_IN_FOLDER,
  MSG_STATUS_ITEMS,
  MSG_UNFILED_NOTICE,
} from '@/constants/messages';
import { filterCount, NO_FILTERS } from '@/lib/media/listing';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/notice';

import { clearSearch, setFilters, setMode } from './navigation';
import { useBrowser } from './store';
import { resultsSource, useListing } from './use-listing';

/** The results the browser shows instead of the tree, and how they load. */
export function useResults() {
  const { query, queryFolder, mode } = useBrowser(
    useShallow((s) => ({
      query: s.query,
      queryFolder: s.queryFolder,
      mode: s.mode,
    }))
  );
  const source = useMemo(
    () => resultsSource({ query, queryFolder, mode }),
    [query, queryFolder, mode]
  );
  return useListing(source);
}

/** What the results are of, said the way the path bar says it. */
export function resultsTitle(
  query: string,
  mode: string,
  folderName: string | undefined
) {
  if (query && folderName !== undefined)
    return MSG_RESULTS_IN_FOLDER(query, folderName);
  if (query) return MSG_RESULTS_EVERYWHERE(query);
  return mode === 'unfiled' ? 'غير مصنّفة' : 'كل الملفات';
}

export const ResultsBanner = memo(
  ({
    listing,
    sticky = true,
  }: {
    listing: Listing | undefined;
    /** The list view keeps its column header there instead. */
    sticky?: boolean;
  }) => {
    const { query, queryFolder, mode, filters } = useBrowser(
      useShallow((s) => ({
        query: s.query,
        queryFolder: s.queryFolder,
        mode: s.mode,
        filters: filterCount(s.filters),
      }))
    );
    const clearFilters = useCallback(() => setFilters(NO_FILTERS), []);
    const toFolders = useCallback(() => setMode('folders'), []);
    const folderName =
      queryFolder === null
        ? undefined
        : (listing?.breadcrumbs?.[listing.breadcrumbs.length - 1]?.name ?? '…');
    const count = listing
      ? MSG_STATUS_ITEMS(listing.folders.length + listing.fileTotal)
      : '…';

    return (
      <div
        data-no-marquee
        className={cn('border-b bg-card', sticky && 'sticky top-0 z-[3]')}
      >
        <div className='flex items-center gap-2.5 px-4 py-2.5'>
          <Icon
            icon={query ? 'lucide:search' : 'lucide:file-image'}
            className='size-4 shrink-0 text-muted-foreground'
          />
          <b className='font-medium' dir='auto'>
            {resultsTitle(query, mode, folderName)}
          </b>
          <span className='flex-1 text-xs text-muted-foreground'>{count}</span>
          {filters > 0 && (
            <Button
              variant='link'
              size='none'
              className='text-xs'
              onClick={clearFilters}
            >
              <Icon icon='lucide:list-filter' className='size-3.5' />
              إزالة التصفية ({filters})
            </Button>
          )}
          {query ? (
            <Button
              variant='link'
              size='none'
              className='text-xs'
              onClick={clearSearch}
            >
              <Icon icon='lucide:x' className='size-3.5' />
              مسح البحث
            </Button>
          ) : (
            <Button
              variant='link'
              size='none'
              className='text-xs'
              onClick={toFolders}
            >
              <Icon icon='lucide:folder-open' className='size-3.5' />
              العودة إلى المجلدات
            </Button>
          )}
        </div>
        {!query &&
          mode === 'unfiled' &&
          listing?.retentionDays !== undefined && (
            <Notice className='mx-4 mb-2.5 text-xs'>
              {MSG_UNFILED_NOTICE(listing.retentionDays)}
            </Notice>
          )}
        {listing?.foldersTruncated && (
          <p className='px-4 pb-2.5 text-xs text-muted-foreground'>
            {MSG_FOLDERS_TRUNCATED}
          </p>
        )}
      </div>
    );
  }
);

ResultsBanner.displayName = 'ResultsBanner';
