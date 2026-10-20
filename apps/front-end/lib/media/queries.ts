import type { LibraryListing, LibraryPage } from './schemas';
import type { BodyOf } from '@/lib/api/client';
import type { TableQuery } from '@/lib/data-table/query';
import type { EntityID } from '@app/shared/types';
import type { PaginationMeta } from '@app/shared/types/api';
import type { MediaScope } from '@app/shared/validation/media';
import type { QueryClient } from '@tanstack/react-query';

import {
  deleteMedia,
  getMediaFile,
  getMediaFolder,
  getMediaStats,
  listMedia,
  previewMediaDelete,
} from '@app/shared/api/media';
import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import {
  endpointPageQuery,
  endpointPagesKey,
  endpointQuery,
  useEndpointPage,
  useEndpointPages,
  useEndpointQuery,
} from '@/lib/api/query';

import {
  deletePreviewKey,
  folderDetailsKeys,
  listingKey,
  mediaKeys,
  pickerKey,
  statsKey,
} from './api';
import { listingSchemas, toLibraryPage } from './schemas';

/** The listing of `scope`; `folder` is the one listed, omitted at the root. */
const listingInput = (scope: MediaScope, folder: EntityID | null) => ({
  query: { scope, ...(folder && { folder }) },
});

/**
 * One listing as it is scrolled: the scope's files, page after page, with its
 * folders beside them on each page.
 */
export function useLibraryPages(
  scope: MediaScope,
  folder: EntityID | null,
  state: Omit<TableQuery, 'page'>,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const narrowed =
    state.filters.length > 0 || effectiveSearchTerm(state.search) !== '';
  return useEndpointPages(listMedia, listingInput(scope, folder), {
    queryKey: listingKey(scope, folder),
    state,
    narrow: listingSchemas[scope],
    toPage: narrowed ? toNarrowedPage : toLibraryPage,
    enabled,
  });
}

const toNarrowedPage = (
  listing: LibraryListing,
  meta: PaginationMeta
): LibraryPage => ({ ...toLibraryPage(listing, meta), narrowed: true });

/** Where `useLibraryPages` caches a listing, for a handler to read it. */
export const libraryPagesKey = (
  scope: MediaScope,
  folder: EntityID | null,
  state: Omit<TableQuery, 'page'>
) => endpointPagesKey(listingKey(scope, folder), state);

/** Its files are not wanted by a folder picker, so one is asked for. */
const PICKER_STATE: TableQuery = {
  page: 1,
  perPage: 1,
  sort: [],
  filters: [],
  joinOperator: 'and',
  search: '',
};

const folderChoices = (folder: EntityID | null) => ({
  queryKey: pickerKey(folder),
  state: PICKER_STATE,
  narrow: listingSchemas.folder,
  toPage: toLibraryPage,
});

/** A folder's path and subfolders, for choosing one. */
export function useFolderChoices(
  folder: EntityID | null,
  { enabled = true }: { enabled?: boolean } = {}
) {
  return useEndpointPage(listMedia, listingInput('folder', folder), {
    ...folderChoices(folder),
    enabled,
  });
}

/** `fresh` asks the server again, for whether the folder is still there now. */
interface FetchOptions {
  fresh?: boolean;
}

/**
 * `useFolderChoices` for a handler: the folder's path, subfolders and file
 * total, from the cache while fresh. Rejects as the listing does, a folder
 * that is gone included.
 */
export const fetchFolderChoices = (
  queryClient: QueryClient,
  folder: EntityID | null,
  { fresh = false }: FetchOptions = {}
) =>
  queryClient.fetchQuery({
    ...endpointPageQuery(
      listMedia,
      listingInput('folder', folder),
      folderChoices(folder)
    ),
    ...(fresh && { staleTime: 0 }),
  });

/** A file with its download link and where it is used; fetched while shown. */
export function useLibraryFile(id: EntityID, { enabled = true } = {}) {
  return useEndpointQuery(
    getMediaFile,
    { params: { id } },
    { queryKey: mediaKeys.detail(id), enabled }
  );
}

/** `useLibraryFile` for a handler; `fresh` for links signed just now. */
export const fetchLibraryFile = (
  queryClient: QueryClient,
  id: EntityID,
  { fresh = false }: FetchOptions = {}
) =>
  queryClient.fetchQuery({
    ...endpointQuery(
      getMediaFile,
      { params: { id } },
      { queryKey: mediaKeys.detail(id) }
    ),
    ...(fresh && { staleTime: 0 }),
  });

/** A folder, its path and what its whole subtree holds. */
export function useFolderDetails(
  id: EntityID | null,
  { enabled = true }: { enabled?: boolean } = {}
) {
  return useEndpointQuery(
    getMediaFolder,
    { params: { id: id ?? '' } },
    {
      queryKey: folderDetailsKeys.one(id ?? ''),
      enabled: enabled && id !== null,
    }
  );
}

/** What the whole library holds. */
export const useLibraryStats = () =>
  useEndpointQuery(getMediaStats, undefined, { queryKey: statsKey });

export type DeleteBody = BodyOf<typeof deleteMedia>;

/**
 * What the delete of `body` would meet now, read with the delete's own body.
 * Advisory: the delete decides again, so it is asked afresh every time.
 */
export const deletePreviewQuery = (body: DeleteBody) => ({
  ...endpointQuery(
    previewMediaDelete,
    { body },
    { queryKey: deletePreviewKey(body) }
  ),
  staleTime: 0,
});
