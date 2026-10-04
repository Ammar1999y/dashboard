import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';
import type { PaginationMeta } from '@app/shared/types/api';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';

import {
  assertDataTableParamKeys,
  invalidFilter,
} from '@app/shared/data-table/filter-rules';
import { parseSearchParams } from '@app/shared/data-table/parsers';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { queryRows } from '@/lib/data-table/query';

import { fail } from './http';

interface DataTableQueryParams {
  filterableColumns: FilterColumnSpecs;
  searchableColumns: string[];
  defaultSort: ExtendedColumnSort<Record<string, unknown>>;
}

/**
 * The server-side table contract `useServerDataTable` speaks, read as
 * `parseDataTableParams` reads it: one page and its `meta`, or the server's
 * error envelope for a query the server refuses.
 */
export function queryTable<T extends object>(
  rows: T[],
  url: URL,
  { filterableColumns, searchableColumns, defaultSort }: DataTableQueryParams
): { data: T[]; meta: PaginationMeta } {
  try {
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
  } catch (error) {
    // Thrown, not returned, so the handlers keep answering `okPage(...)`:
    // MSW answers a thrown `Response` as the mocked one.
    if (error instanceof CustomError)
      throw fail(
        error.status ?? HTTP_STATUS.BAD_REQUEST,
        error.message,
        error.code
      );
    throw error;
  }
}
