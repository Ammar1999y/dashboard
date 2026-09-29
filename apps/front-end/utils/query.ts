import type { EntityID } from '@/types';
import type { ServerPage } from '@/utils/query-cache';
import type { DataTableState } from '@/utils/store/data-table-store';
import type { PaginationMeta } from '@app/shared/types/api';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PER_PAGE,
  MIN_SEARCH_LENGTH,
  searchTermLength,
} from '@app/shared/data-table/parsers';
import { apiFetch } from '@/lib/api';

import { CustomError } from './error-class';
import { OFFLINE_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from './error-messages';

/** Fetches an API envelope and returns it once `success` is set; every failure becomes a `CustomError`. */
async function fetchEnvelope<TData, TMeta = undefined>(
  href: string,
  signal: AbortSignal
): Promise<{ data: TData; meta?: TMeta }> {
  try {
    const response = await apiFetch(href, { signal });
    const result = await response.json();

    if (!response.ok || !result.success)
      throw new CustomError(
        result.message || UNEXPECTED_ERROR_MESSAGE,
        response.status
      );
    return result;
  } catch (error) {
    if (error instanceof CustomError) throw error;
    if (error instanceof TypeError) throw new CustomError(OFFLINE_MESSAGE, 503);
    throw new CustomError(UNEXPECTED_ERROR_MESSAGE, 500);
  }
}

export const useQueryData = <TData = unknown>({
  queryKey,
  href,
  enabled = true,
}: {
  queryKey: (string | number | EntityID)[];
  href: string;
  /** The one gate: a detail query passes `!!id` so it waits for the route. */
  enabled?: boolean;
}) =>
  useQuery<TData>({
    queryKey,
    queryFn: async ({ signal }) => {
      const { data } = await fetchEnvelope<TData>(href, signal);
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

// Below the trigram floor the server ignores the term, so it is neither sent
// nor part of the cache key: typing the first letters must not refetch.
const effectiveSearch = (search: string) =>
  searchTermLength(search) >= MIN_SEARCH_LENGTH ? search : '';

function buildDataTableUrl(baseHref: string, state: DataTableState): string {
  const params = new URLSearchParams();

  if (state.page !== DEFAULT_META.page) params.set('page', String(state.page));
  if (state.perPage !== DEFAULT_META.perPage)
    params.set('perPage', String(state.perPage));
  if (state.sort.length > 0) params.set('sort', JSON.stringify(state.sort));
  if (state.filters.length > 0)
    params.set('filters', JSON.stringify(state.filters));
  if (state.joinOperator !== 'and')
    params.set('joinOperator', state.joinOperator);
  const search = effectiveSearch(state.search);
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
  queryKey: (string | number | EntityID)[];
  href: string;
  state: DataTableState;
}) => {
  const { page, perPage, sort, filters, joinOperator } = state;
  const search = effectiveSearch(state.search);
  const fullUrl = buildDataTableUrl(href, state);

  const query = useQuery<ServerPage<TData>>({
    queryKey: [...queryKey, page, perPage, sort, filters, joinOperator, search],
    queryFn: async ({ signal }) => {
      const result = await fetchEnvelope<TData[] | undefined, PaginationMeta>(
        fullUrl,
        signal
      );
      return {
        data: result.data ?? [],
        meta: result.meta ?? DEFAULT_META,
      };
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
