import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';
import type { PaginationMeta } from '@app/shared/types/api';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';

import {
  assertDataTableParamKeys,
  invalidFilter,
} from '@app/shared/data-table/filter-rules';
import { parseSearchParams } from '@app/shared/data-table/parsers';
import { queryRows } from '@/lib/data-table/query';

interface DataTableQueryParams {
  filterableColumns: FilterColumnSpecs;
  searchableColumns: string[];
  defaultSort: ExtendedColumnSort<Record<string, unknown>>;
}

/**
 * The server-side table contract `useEndpointTable` speaks, read as
 * `parseDataTableParams` reads it: one page and its `meta`, or the server's
 * 422 for a query it refuses.
 */
export function queryTable<T extends object>(
  rows: T[],
  url: URL,
  { filterableColumns, searchableColumns, defaultSort }: DataTableQueryParams
): { data: T[]; meta: PaginationMeta } {
  assertDataTableParamKeys(url.searchParams);
  const { page, perPage, sort, filters, joinOperator } = parseSearchParams(
    Object.fromEntries(url.searchParams),
    {
      defaultSort,
      sortableColumnIds: Object.keys(filterableColumns),
      onFilterDropped: () => invalidFilter(),
    }
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
    { searchableColumns, filterableColumns }
  );
}
