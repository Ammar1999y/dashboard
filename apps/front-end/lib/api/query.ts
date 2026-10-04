import type { ServerPage } from './query-cache';
import type { TableQuery } from '@/lib/data-table/query';
import type { PaginationMeta } from '@app/shared/types/api';
import type { QueryKey } from '@tanstack/react-query';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PER_PAGE,
  effectiveSearchTerm,
} from '@app/shared/data-table/parsers';

import { apiRequest, invalidResponse } from './fetch';

export const useQueryData = <TData = unknown>({
  queryKey,
  href,
  enabled = true,
}: {
  queryKey: QueryKey;
  href: string;
  /** The one gate: a detail query passes `!!id` so it waits for the route. */
  enabled?: boolean;
}) =>
  useQuery<TData>({
    queryKey,
    queryFn: async ({ signal }) => {
      const { data } = await apiRequest<TData>(href, { signal });
      return data;
    },
    enabled,
  });

const DEFAULT_META: PaginationMeta = {
  page: 1,
  perPage: DEFAULT_PER_PAGE,
  total: 0,
  pageCount: 1,
};

function buildDataTableUrl(baseHref: string, state: TableQuery): string {
  const params = new URLSearchParams();

  if (state.page !== DEFAULT_META.page) params.set('page', String(state.page));
  if (state.perPage !== DEFAULT_META.perPage)
    params.set('perPage', String(state.perPage));
  if (state.sort.length > 0) params.set('sort', JSON.stringify(state.sort));
  if (state.filters.length > 0)
    params.set('filters', JSON.stringify(state.filters));
  if (state.joinOperator !== 'and')
    params.set('joinOperator', state.joinOperator);
  const search = effectiveSearchTerm(state.search);
  if (search) params.set('search', search);

  const qs = params.toString();
  return qs ? `${baseHref}?${qs}` : baseHref;
}

/**
 * React Query hook for server-side data-table pages: sends the table's URL
 * state as query params and returns one page with its `meta`.
 */
export const useServerDataTable = <TData = unknown>({
  queryKey,
  href,
  state,
}: {
  queryKey: QueryKey;
  href: string;
  state: TableQuery;
}) => {
  const { page, perPage, sort, filters, joinOperator } = state;
  // A term the server ignores is neither sent nor part of the cache key:
  // typing the first letters must not refetch.
  const search = effectiveSearchTerm(state.search);
  const fullUrl = buildDataTableUrl(href, state);

  const query = useQuery<ServerPage<TData>>({
    queryKey: [...queryKey, page, perPage, sort, filters, joinOperator, search],
    queryFn: async ({ signal }) => {
      const result = await apiRequest<TData[]>(fullUrl, { signal });
      if (!Array.isArray(result.data) || !result.meta) throw invalidResponse();
      return { data: result.data, meta: result.meta };
    },
    placeholderData: keepPreviousData,
  });

  return {
    data: query.data?.data,
    meta: query.data?.meta ?? DEFAULT_META,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
};
