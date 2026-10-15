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
import { writeTableQuery } from '@/lib/data-table/url';

import { apiRequest, invalidResponse } from './fetch';

interface QueryDataOptions<S extends z.ZodType> {
  queryKey: QueryKey;
  href: string;
  /** The one gate: a detail query passes `!!id` so it waits for the route. */
  enabled?: boolean;
  /**
   * What the caller reads of the endpoint's `data`, typed as its output. A body
   * that does not match is an `invalidResponse()` error.
   */
  schema: S;
}

/**
 * The key and fetch of `useQueryData`, for a handler that needs the same data
 * outside render (`queryClient.fetchQuery`), so both share one cache entry.
 */
export function queryDataQuery<S extends z.ZodType>({
  queryKey,
  href,
  schema,
}: Omit<QueryDataOptions<S>, 'enabled'>) {
  return {
    queryKey,
    queryFn: async ({
      signal,
    }: {
      signal: AbortSignal;
    }): Promise<z.output<S>> => {
      const { data } = await apiRequest(href, { signal, schema });
      return data;
    },
  };
}

/** One query on an endpoint's `data`, checked against `schema`. */
export function useQueryData<S extends z.ZodType>({
  enabled = true,
  ...options
}: QueryDataOptions<S>): UseQueryResult<z.output<S>> {
  return useQuery({ ...queryDataQuery(options), enabled });
}

const DEFAULT_META: PaginationMeta = {
  page: 1,
  perPage: DEFAULT_PER_PAGE,
  total: 0,
  pageCount: 1,
};

function buildDataTableUrl(baseHref: string, state: TableQuery): string {
  const params = new URLSearchParams();
  writeTableQuery(params, {
    ...state,
    search: effectiveSearchTerm(state.search),
  });

  const qs = params.toString();
  if (!qs) return baseHref;
  return `${baseHref}${baseHref.includes('?') ? '&' : '?'}${qs}`;
}

/** `toPage` receives the response's `data`, parsed by `schema`, and its `meta`. */
interface ServerPageOptions<S extends z.ZodType, TPage> {
  queryKey: QueryKey;
  /** May carry its own query, which the table's params are appended to. */
  href: string;
  state: TableQuery;
  toPage: (data: z.output<S>, meta: PaginationMeta) => TPage;
  /** What `toPage` receives as `data`, parsed; see `useQueryData`. */
  schema: S;
  enabled?: boolean;
}

/**
 * The key and fetch of one server page, for `useServerPage` and for a handler
 * that needs the same page outside render (`queryClient.fetchQuery`), so both
 * share one cache entry.
 */
export function serverPageQuery<S extends z.ZodType, TPage>({
  queryKey,
  href,
  state,
  toPage,
  schema,
}: ServerPageOptions<S, TPage>) {
  const { page, perPage, sort, filters, joinOperator } = state;
  // A term the server ignores is neither sent nor part of the cache key:
  // typing the first letters must not refetch.
  const search = effectiveSearchTerm(state.search);
  const fullUrl = buildDataTableUrl(href, state);
  return {
    queryKey: [...queryKey, page, perPage, sort, filters, joinOperator, search],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<TPage> => {
      const result = await apiRequest(fullUrl, { signal, schema });
      if (!result.meta) throw invalidResponse();
      return toPage(result.data, result.meta);
    },
  };
}

interface ServerPageResult<TPage> {
  page: TPage | undefined;
  meta: PaginationMeta;
  isLoading: boolean;
  error: Error | null;
  refetch: UseQueryResult<TPage>['refetch'];
}

/**
 * React Query hook for server-side data-table pages: sends the table's URL
 * state as query params and caches one page with its `meta`. A page may hold
 * more than its rows, as `toPage` builds it from `data`, typed as the
 * `schema`'s output.
 */
export function useServerPage<
  S extends z.ZodType,
  TPage extends ServerPage<unknown>,
>({
  enabled = true,
  ...options
}: ServerPageOptions<S, TPage>): ServerPageResult<TPage> {
  const query = useQuery<TPage>({
    ...serverPageQuery(options),
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

interface ServerPagesOptions<S extends z.ZodType, TPage> extends Omit<
  ServerPageOptions<S, TPage>,
  'state'
> {
  /** Everything but the page, which each fetch of the next one advances. */
  state: Omit<TableQuery, 'page'>;
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

/** Where `useServerPages` caches the pages of `state`, for a handler to read them. */
export function serverPagesKey(
  queryKey: QueryKey,
  state: Omit<TableQuery, 'page'>
): QueryKey {
  const { perPage, sort, filters, joinOperator } = state;
  // As for one page: a term the server ignores is not part of the key.
  const search = effectiveSearchTerm(state.search);
  return [...queryKey, 'pages', perPage, sort, filters, joinOperator, search];
}

/**
 * `useServerPage` for a list that grows as it is scrolled: one cache entry
 * holds every page fetched so far, under the `pages` segment so it never
 * shares a key with a single page.
 */
export function useServerPages<
  S extends z.ZodType,
  TPage extends ServerPage<unknown>,
>({
  queryKey,
  href,
  state,
  toPage,
  schema,
  enabled = true,
}: ServerPagesOptions<S, TPage>): ServerPagesResult<TPage> {
  const query = useInfiniteQuery({
    queryKey: serverPagesKey(queryKey, state),
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const url = buildDataTableUrl(href, { ...state, page: pageParam });
      const result = await apiRequest(url, { signal, schema });
      if (!result.meta) throw invalidResponse();
      return toPage(result.data, result.meta);
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

/**
 * `useServerPage` for an endpoint whose `data` is the rows. `schema` is the
 * rows' array schema (`z.array(rowSchema)`), and types them as its output.
 */
export function useServerDataTable<S extends z.ZodType<readonly unknown[]>>(
  options: Omit<ServerPageOptions<S, ServerPage<z.output<S>[number]>>, 'toPage'>
) {
  const { page, ...rest } = useServerPage({
    ...options,
    toPage: (data, meta): ServerPage<z.output<S>[number]> => ({
      data: [...data],
      meta,
    }),
  });
  return { ...rest, data: page?.data };
}
