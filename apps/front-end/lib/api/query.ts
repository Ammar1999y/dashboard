import type {
  CallInput,
  ClientEndpoint,
  DataOf,
  PagedEndpoint,
} from './client';
import type { ServerPage } from './query-cache';
import type { TableQuery } from '@/lib/data-table/query';
import type { PaginationMeta } from '@app/shared/types/api';
import type { QueryKey, UseQueryResult } from '@tanstack/react-query';
import type * as z from 'zod';

import { useCallback } from 'react';

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import {
  DEFAULT_PER_PAGE,
  effectiveSearchTerm,
} from '@app/shared/data-table/parsers';

import { readData, readPage } from './client';

const DEFAULT_META: PaginationMeta = {
  page: 1,
  perPage: DEFAULT_PER_PAGE,
  total: 0,
  pageCount: 1,
};

interface ServerPageResult<TPage> {
  page: TPage | undefined;
  meta: PaginationMeta;
  isLoading: boolean;
  error: Error | null;
  refetch: UseQueryResult<TPage>['refetch'];
}

interface ServerPagesResult<TPage> {
  /** Every page fetched so far, in order; `undefined` until the first answers. */
  pages: TPage[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** The last fetch of a next page failed; `error` says why. */
  isFetchNextPageError: boolean;
}

interface EndpointQueryOptions<N> {
  queryKey: QueryKey;
  /** A stricter view of `data` than the entry's. */
  narrow?: z.ZodType<N>;
}

/**
 * The key and fetch of `useEndpointQuery`, for a handler that needs the same
 * data outside render (`queryClient.fetchQuery`), so both share one cache entry.
 * A read whatever the method, as a delete's preview is.
 */
export function endpointQuery<E extends ClientEndpoint, N = DataOf<E>>(
  entry: E,
  input: CallInput<E> | undefined,
  { queryKey, narrow }: EndpointQueryOptions<N>
) {
  return {
    queryKey,
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<N> =>
      readData<E, N>(entry, input, { signal, narrow }),
  };
}

/** One query on `entry`'s `data`, or a raw entry's whole body, parsed by it. */
export function useEndpointQuery<E extends ClientEndpoint, N = DataOf<E>>(
  entry: E,
  input: CallInput<E> | undefined,
  {
    enabled = true,
    ...options
  }: EndpointQueryOptions<N> & {
    /** The one gate: a detail query passes `!!id` so it waits for the route. */
    enabled?: boolean;
  }
): UseQueryResult<N> {
  return useQuery({ ...endpointQuery(entry, input, options), enabled });
}

interface EndpointPageOptions<N, TPage> extends EndpointQueryOptions<N> {
  state: TableQuery;
  /** Receives the page's `data`, parsed, and its `meta`. */
  toPage: (data: N, meta: PaginationMeta) => TPage;
  enabled?: boolean;
}

/** The table's state as it keys a page: a search the server ignores is not part of it. */
const pageKey = (queryKey: QueryKey, state: Omit<TableQuery, 'page'>) => {
  const { perPage, sort, filters, joinOperator } = state;
  return [
    ...queryKey,
    perPage,
    sort,
    filters,
    joinOperator,
    effectiveSearchTerm(state.search),
  ];
};

/**
 * The key and fetch of one page of a list, for `useEndpointPage` and for a
 * handler that needs the same page outside render, so both share one cache
 * entry.
 */
export function endpointPageQuery<
  E extends PagedEndpoint,
  TPage,
  N = DataOf<E>,
>(
  entry: E,
  input: CallInput<E> | undefined,
  { queryKey, state, toPage, narrow }: EndpointPageOptions<N, TPage>
) {
  return {
    queryKey: pageKey([...queryKey, state.page], state),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<TPage> => {
      const { data, meta } = await readPage<E, N>(entry, input, {
        signal,
        narrow,
        table: state,
      });
      return toPage(data, meta);
    },
  };
}

/**
 * One page of a list, with its `meta`, keeping the previous page shown while
 * the next loads. A page may hold more than its rows, as `toPage` builds it.
 */
export function useEndpointPage<
  E extends PagedEndpoint,
  TPage extends ServerPage<unknown>,
  N = DataOf<E>,
>(
  entry: E,
  input: CallInput<E> | undefined,
  { enabled = true, ...options }: EndpointPageOptions<N, TPage>
): ServerPageResult<TPage> {
  const query = useQuery<TPage>({
    ...endpointPageQuery(entry, input, options),
    placeholderData: keepPreviousData,
    enabled,
  });

  return {
    page: query.data,
    meta: query.data?.meta ?? DEFAULT_META,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

interface EndpointPagesOptions<N, TPage> extends Omit<
  EndpointPageOptions<N, TPage>,
  'state'
> {
  /** Everything but the page, which each fetch of the next one advances. */
  state: Omit<TableQuery, 'page'>;
}

/** Where `useEndpointPages` caches the pages of `state`, for a handler to read them. */
export const endpointPagesKey = (
  queryKey: QueryKey,
  state: Omit<TableQuery, 'page'>
): QueryKey => pageKey([...queryKey, 'pages'], state);

/**
 * `useEndpointPage` for a list that grows as it is scrolled: one cache entry
 * holds every page fetched so far, under the `pages` segment so it never
 * shares a key with a single page.
 */
export function useEndpointPages<
  E extends PagedEndpoint,
  TPage extends ServerPage<unknown>,
  N = DataOf<E>,
>(
  entry: E,
  input: CallInput<E> | undefined,
  {
    queryKey,
    state,
    toPage,
    narrow,
    enabled = true,
  }: EndpointPagesOptions<N, TPage>
): ServerPagesResult<TPage> {
  const query = useInfiniteQuery({
    queryKey: endpointPagesKey(queryKey, state),
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const { data, meta } = await readPage<E, N>(entry, input, {
        signal,
        narrow,
        table: { ...state, page: pageParam },
      });
      return toPage(data, meta);
    },
    getNextPageParam: (last: TPage) =>
      last.meta.page < last.meta.pageCount ? last.meta.page + 1 : undefined,
    enabled,
  });

  const { refetch, fetchNextPage } = query;
  return {
    pages: query.data?.pages,
    isLoading: query.isLoading,
    error: query.error,
    refetch: useCallback(() => void refetch(), [refetch]),
    fetchNextPage: useCallback(
      () => void fetchNextPage({ cancelRefetch: false }),
      [fetchNextPage]
    ),
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
  };
}

/** `useEndpointPage` for a list whose `data` is the rows. */
export function useEndpointTable<
  E extends PagedEndpoint,
  TRow = DataOf<E> extends readonly (infer R)[] ? R : never,
>(
  entry: E,
  input: CallInput<E> | undefined,
  options: Omit<
    EndpointPageOptions<readonly TRow[], ServerPage<TRow>>,
    'toPage'
  >
) {
  const { page, ...rest } = useEndpointPage(entry, input, {
    ...options,
    toPage: (data, meta): ServerPage<TRow> => ({ data: [...data], meta }),
  });
  return { ...rest, data: page?.data };
}
