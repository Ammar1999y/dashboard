import type { TableQueryOptions } from '@/lib/data-table/query';
import type { PaginationMeta } from '@app/shared/types/api';

import { parseSearchParams } from '@app/shared/data-table/parsers';
import { queryRows } from '@/lib/data-table/query';

/**
 * The server-side table contract `useServerDataTable` speaks: the same URL
 * parameters, answered with one page and its `meta`.
 */
export function queryTable<T extends object>(
  rows: T[],
  url: URL,
  options: TableQueryOptions<T>
): { data: T[]; meta: PaginationMeta } {
  const { page, perPage, sort, filters, joinOperator } = parseSearchParams(
    Object.fromEntries(url.searchParams)
  );
  return queryRows(
    rows,
    {
      page,
      perPage,
      sort,
      filters,
      joinOperator,
      search: url.searchParams.get('search') ?? '',
    },
    options
  );
}
