import type { ItemKey } from '@/lib/media/keys';
import type {
  Breadcrumb,
  FolderHit,
  LibraryFile,
  LibraryFolder,
  LibraryPage,
} from '@/lib/media/schemas';
import type { EntityID } from '@app/shared/types';
import type { MediaScope } from '@app/shared/validation/media';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import { useEffect, useMemo } from 'react';

import { useShallow } from 'zustand/shallow';
import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import { useCapabilities } from '@/lib/media/capabilities';
import { fileKey, folderKey } from '@/lib/media/keys';
import { listingState } from '@/lib/media/listing';
import { libraryPagesKey, useLibraryPages } from '@/lib/media/queries';

import { getBrowser, useBrowser } from './store';

/** Which listing to show: the library is asked for one per source. */
export interface ListingSource {
  scope: MediaScope;
  folder: EntityID | null;
  search: string;
}

export type ListedFolder = LibraryFolder | FolderHit;

/** A listing's pages as one list, what a view renders and a handler reads. */
export interface Listing {
  folders: readonly ListedFolder[];
  files: readonly LibraryFile[];
  /** Every file the listing has, fetched or not. */
  fileTotal: number;
  /** Root to the listed folder; for a folder's listing only. */
  breadcrumbs: readonly Breadcrumb[] | undefined;
  /** More folders match a search than the server names. */
  foldersTruncated: boolean;
  /** How long an unfiled file is kept; for the unfiled listing only. */
  retentionDays: number | undefined;
}

/** The listing of a folder of the tree. */
export const folderSource = (folder: EntityID | null): ListingSource => ({
  scope: 'folder',
  folder,
  search: '',
});

/** What the results views list: the search, or every file of a scope. */
export function resultsSource(
  state: Pick<ReturnType<typeof getBrowser>, 'query' | 'queryFolder' | 'mode'>
): ListingSource {
  if (state.query && state.queryFolder !== null)
    return { scope: 'folder', folder: state.queryFolder, search: state.query };
  return {
    scope: state.mode === 'unfiled' ? 'unfiled' : 'all',
    folder: null,
    search: state.query,
  };
}

/**
 * The server filters a folder's files by the search but returns its subfolders
 * whole, so their names are matched here, as the library's search matches them.
 */
const nameFilter = (source: ListingSource) => {
  const term = effectiveSearchTerm(source.search).toLowerCase();
  return term && source.scope === 'folder'
    ? (folder: ListedFolder) => folder.name.toLowerCase().includes(term)
    : undefined;
};

/** Flattens `pages`; a file a later page repeats, after a row moved up, is kept once. */
export function flattenPages(
  pages: readonly LibraryPage[],
  keepFolder?: (folder: ListedFolder) => boolean
): Listing {
  const [first] = pages;
  const files = [
    ...new Map(
      pages
        .flatMap((page) => page.data)
        .reverse()
        .map((file) => [file.id, file])
    ).values(),
  ].reverse();
  const context = first?.context;
  const folders: readonly ListedFolder[] =
    context && context.scope !== 'unfiled' ? context.folders : [];
  return {
    folders: keepFolder ? folders.filter(keepFolder) : folders,
    files,
    fileTotal: Math.max(first?.meta.total ?? 0, files.length),
    breadcrumbs: context?.scope === 'folder' ? context.breadcrumbs : undefined,
    foldersTruncated: context?.scope === 'all' && context.foldersTruncated,
    retentionDays:
      context?.scope === 'unfiled' ? context.retentionDays : undefined,
  };
}

/** Folders first, then files, as every view lists them. */
export const listingKeys = (listing: Listing): ItemKey[] => [
  ...listing.folders.map(({ id }) => folderKey(id)),
  ...listing.files.map(({ id }) => fileKey(id)),
];

const useQueryState = () =>
  useBrowser(useShallow((s) => ({ sort: s.sort, filters: s.filters })));

/** One listing, fetched page after page as it is scrolled. */
export function useListing(
  source: ListingSource,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const { sort, filters } = useQueryState();
  const { scope, folder, search } = source;
  const state = useMemo(
    () => listingState(sort, filters, search),
    [sort, filters, search]
  );
  const result = useLibraryPages(scope, folder, state, { enabled });
  const { pages } = result;

  const listing = useMemo(
    () =>
      pages
        ? flattenPages(pages, nameFilter({ scope, folder, search }))
        : undefined,
    [pages, scope, folder, search]
  );

  const first = pages?.[0];
  useEffect(() => {
    if (!first) return;
    const { canPublish, visibilities } = useCapabilities.getState();
    const same =
      canPublish === first.canPublish &&
      visibilities.length === first.visibilities.length &&
      visibilities.every((value, index) => first.visibilities[index] === value);
    if (!same)
      useCapabilities.setState({
        canPublish: first.canPublish,
        visibilities: first.visibilities,
      });
  }, [first]);

  const nextPageError = result.isFetchNextPageError ? result.error : null;
  return { ...result, listing, nextPageError };
}

/** The listing as the cache holds it, for a handler; `undefined` before it loads. */
export function readListing(
  queryClient: QueryClient,
  source: ListingSource
): Listing | undefined {
  const { sort, filters } = getBrowser();
  const pages = queryClient.getQueryData<InfiniteData<LibraryPage>>(
    libraryPagesKey(
      source.scope,
      source.folder,
      listingState(sort, filters, source.search)
    )
  )?.pages;
  return pages ? flattenPages(pages, nameFilter(source)) : undefined;
}
