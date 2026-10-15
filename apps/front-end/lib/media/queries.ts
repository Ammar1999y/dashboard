import type { LibraryListing, LibraryPage } from './schemas';
import type { TableQuery } from '@/lib/data-table/query';
import type { RequestBody } from '@app/shared/contract';
import type { EntityID } from '@app/shared/types';
import type { PaginationMeta } from '@app/shared/types/api';
import type { MediaScope } from '@app/shared/validation/media';
import type { QueryClient } from '@tanstack/react-query';

import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import {
  deletePreviewSchema,
  mediaFileDetailsSchema,
  mediaFolderDetailsSchema,
  mediaStatsSchema,
} from '@app/shared/responses/media';
import { apiRequest } from '@/lib/api/fetch';
import {
  queryDataQuery,
  serverPageQuery,
  serverPagesKey,
  useQueryData,
  useServerPage,
  useServerPages,
} from '@/lib/api/query';

import {
  DELETE_PREVIEW_API,
  deletePreviewKey,
  fileHref,
  folderDetailsKeys,
  folderHref,
  listingHref,
  listingKey,
  mediaKeys,
  pickerKey,
  STATS_API,
  statsKey,
} from './api';
import { listingSchemas, toLibraryPage } from './schemas';

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
  return useServerPages({
    queryKey: listingKey(scope, folder),
    href: listingHref(scope, folder),
    state,
    schema: listingSchemas[scope],
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
) => serverPagesKey(listingKey(scope, folder), state);

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
  href: listingHref('folder', folder),
  state: PICKER_STATE,
  schema: listingSchemas.folder,
  toPage: toLibraryPage,
});

/** A folder's path and subfolders, for choosing one. */
export function useFolderChoices(
  folder: EntityID | null,
  { enabled = true }: { enabled?: boolean } = {}
) {
  return useServerPage({ ...folderChoices(folder), enabled });
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
    ...serverPageQuery(folderChoices(folder)),
    ...(fresh && { staleTime: 0 }),
  });

const libraryFile = (id: EntityID) => ({
  queryKey: mediaKeys.detail(id),
  href: fileHref(id),
  schema: mediaFileDetailsSchema,
});

/** A file with its download link and where it is used; fetched while shown. */
export function useLibraryFile(id: EntityID, { enabled = true } = {}) {
  return useQueryData({ ...libraryFile(id), enabled });
}

/** `useLibraryFile` for a handler; `fresh` for links signed just now. */
export const fetchLibraryFile = (
  queryClient: QueryClient,
  id: EntityID,
  { fresh = false }: FetchOptions = {}
) =>
  queryClient.fetchQuery({
    ...queryDataQuery(libraryFile(id)),
    ...(fresh && { staleTime: 0 }),
  });

/** A folder, its path and what its whole subtree holds. */
export function useFolderDetails(
  id: EntityID | null,
  { enabled = true }: { enabled?: boolean } = {}
) {
  return useQueryData({
    queryKey: folderDetailsKeys.one(id ?? ''),
    href: folderHref(id ?? ''),
    schema: mediaFolderDetailsSchema,
    enabled: enabled && id !== null,
  });
}

/** What the whole library holds. */
export const useLibraryStats = () =>
  useQueryData({
    queryKey: statsKey,
    href: STATS_API,
    schema: mediaStatsSchema,
  });

export type DeleteBody = RequestBody<'DELETE /api/dash/media'>;

/**
 * What the delete of `body` would meet now, read with the delete's own body.
 * Advisory: the delete decides again, so it is asked afresh every time.
 */
export const deletePreviewQuery = (body: DeleteBody) => ({
  queryKey: deletePreviewKey(body),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const { data } = await apiRequest(DELETE_PREVIEW_API, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal,
      schema: deletePreviewSchema,
    });
    return data;
  },
  staleTime: 0,
});
