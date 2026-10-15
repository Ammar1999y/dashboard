import type { TableQuery } from './query';

import {
  DATA_TABLE_PARAMS,
  DEFAULT_PER_PAGE,
  parseTableParams,
} from '@app/shared/data-table/parsers';

type Sort = TableQuery['sort'];

/** The keys the table writes; `maxPerPage` is a request's own cap, never the table's. */
const TABLE_KEYS = [
  DATA_TABLE_PARAMS.page,
  DATA_TABLE_PARAMS.perPage,
  DATA_TABLE_PARAMS.sort,
  DATA_TABLE_PARAMS.filters,
  DATA_TABLE_PARAMS.joinOperator,
  DATA_TABLE_PARAMS.search,
];

export function sameSort(a: Sort, b: Sort): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.id === b[i]?.id && item.desc === b[i]?.desc);
}

/**
 * The table's query in `params`, parsed as the server parses it but lenient:
 * what does not parse reads as its default.
 */
export function readTableQuery(
  params: URLSearchParams,
  defaultSort: Sort = []
): TableQuery {
  const { sort, filters, ...query } = parseTableParams(
    Object.fromEntries(params)
  );
  return {
    ...query,
    sort: sort.length > 0 ? sort : defaultSort,
    filters,
    // Filters and the quick search exclude each other; filters win.
    search:
      filters.length > 0 ? '' : (params.get(DATA_TABLE_PARAMS.search) ?? ''),
  };
}

/**
 * Writes `query` over the table's keys in `params`, leaving every other key.
 * A value at its default is left out. `defaultSort` is left out too when
 * given: the address omits it, while a request to the server names its sort.
 */
export function writeTableQuery(
  params: URLSearchParams,
  query: TableQuery,
  defaultSort?: Sort
): void {
  for (const key of TABLE_KEYS) params.delete(key);
  const { page, perPage, sort, filters, joinOperator, search } = query;

  if (page !== 1) params.set(DATA_TABLE_PARAMS.page, String(page));
  if (perPage !== DEFAULT_PER_PAGE)
    params.set(DATA_TABLE_PARAMS.perPage, String(perPage));
  if (sort.length > 0 && !(defaultSort && sameSort(sort, defaultSort)))
    params.set(DATA_TABLE_PARAMS.sort, JSON.stringify(sort));
  if (filters.length > 0)
    params.set(DATA_TABLE_PARAMS.filters, JSON.stringify(filters));
  if (joinOperator !== 'and')
    params.set(DATA_TABLE_PARAMS.joinOperator, joinOperator);
  if (search) params.set(DATA_TABLE_PARAMS.search, search);
}
