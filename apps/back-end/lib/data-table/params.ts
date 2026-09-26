import type { FilterColumnSpecs } from './column-specs';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';
import type { SQL, Table } from 'drizzle-orm';

import { and, asc, desc, ilike, or } from 'drizzle-orm';

import { HTTP_STATUS } from '@app/shared/api-messages';
import {
  DATA_TABLE_PARAM_KEYS,
  isTrigramIndexable,
  MAX_PER_PAGE,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  parseSearchParams,
  searchTermLength,
  stripControlAndTrim,
} from '@app/shared/data-table/parsers';
import { CustomError } from '@app/shared/error-class';

import {
  escapeLike,
  filterColumns,
  getColumn,
  MSG_INVALID_FILTER,
} from './filter-columns';

/** `search` is read here rather than by the parser, so it is added here too. */
const ACCEPTED_PARAM_KEYS = new Set([...DATA_TABLE_PARAM_KEYS, 'search']);

interface DataTableQueryParams<T extends Table> {
  url: string;
  /**
   * Server-owned descriptors for every filterable/sortable column. Its keys
   * ARE the allowlist — a column with no descriptor can be neither filtered
   * nor sorted, and an unknown one is rejected rather than dropped.
   */
  filterableColumns: FilterColumnSpecs;
  /** Columns to match against for quick search (?search=) */
  searchableColumns?: string[];
  defaultSort?: ExtendedColumnSort<T>;
}

interface DataTableQueryResult {
  where: SQL | undefined;
  orderBy: ReturnType<typeof asc>[];
  limit: number;
  offset: number;
  page: number;
  perPage: number;
  /** The quick-search term after normalisation and the length bounds; `''` when there is none. */
  search: string;
  buildPageCount: (total: number) => number;
}

/**
 * Parses URL search params and builds Drizzle-compatible
 * where, orderBy, limit, and offset values for data-table queries.
 */
export function parseDataTableParams<T extends Table>(
  table: T,
  {
    url,
    filterableColumns,
    searchableColumns,
    defaultSort,
  }: DataTableQueryParams<T>
): DataTableQueryResult {
  const { searchParams } = new URL(url);

  // Unknown as well as repeated: an ignored `serach=` would answer an
  // unfiltered 200 that the caller reads as a search result.
  const seen = new Set<string>();
  for (const key of searchParams.keys()) {
    if (seen.has(key) || !ACCEPTED_PARAM_KEYS.has(key))
      throw new CustomError(MSG_INVALID_FILTER, HTTP_STATUS.UNPROCESSABLE);
    seen.add(key);
  }

  const params: Record<string, string | undefined> =
    Object.fromEntries(searchParams);

  // A filter the parser could not read is a client error, not a filter to
  // ignore: dropping it silently broadens an `and` query and narrows an `or`
  // one, so the caller gets rows they never asked for with a 200.
  const parsed = parseSearchParams<T>(params, {
    defaultSort,
    // The allowlist, handed to the parser rather than applied to its output:
    // its `defaultSort` fallback has to run AFTER unknown ids are dropped, or a
    // sort naming a column outside this map takes the handler's declared
    // ordering with it and leaves only the primary-key tiebreaker.
    sortableColumnIds: Object.keys(filterableColumns),
    onFilterDropped: () => {
      throw new CustomError(MSG_INVALID_FILTER, HTTP_STATUS.UNPROCESSABLE);
    },
  });

  const safePerPage = Math.min(parsed.perPage, MAX_PER_PAGE);

  // `filterColumns` turns an unknown column, an operator the column's type
  // can't support, or a sub-trigram search term into a 422.
  const filterWhere =
    parsed.filters.length > 0
      ? filterColumns({
          table,
          filters: parsed.filters,
          joinOperator: parsed.joinOperator,
          specs: filterableColumns,
        })
      : undefined;

  // Out-of-range search terms are IGNORED, not rejected — the opposite of the
  // filter contract above, deliberately. The trigram floor is an index policy,
  // not a statement about malformed input: dropping a standalone search term
  // returns the caller's ordinary authorized list, and a bookmarked 1-2
  // character URL is a compatibility case, not an attack. A term that clears
  // the floor but yields no trigram — `!!!`, `😀😀😀` — is dropped by the same
  // rule, for the scan it would otherwise force.
  const rawSearch = stripControlAndTrim(searchParams.get('search') ?? '');
  const rawSearchLength = searchTermLength(rawSearch);
  const search =
    rawSearchLength >= MIN_SEARCH_LENGTH &&
    rawSearchLength <= MAX_SEARCH_LENGTH &&
    isTrigramIndexable(rawSearch)
      ? rawSearch
      : '';

  let searchWhere: SQL | undefined;
  if (search && searchableColumns?.length) {
    const escaped = escapeLike(search);
    const conditions: SQL[] = [];
    for (const colName of searchableColumns) {
      const col = getColumn(table, colName);
      if (col) conditions.push(ilike(col, `%${escaped}%`));
    }
    if (conditions.length > 0) searchWhere = or(...conditions);
  }

  // Filters and search are mutually exclusive on the client; both are
  // honoured, with AND.
  const where = and(filterWhere, searchWhere);

  // Sorting stays lenient: an unknown sort key only changes row ORDER, never
  // which rows are returned. Client ids are already filtered inside the parser;
  // this catches a SERVER-declared `defaultSort` naming a column absent from
  // the map. `Object.hasOwn`, not `in`, so a sort id of `constructor` is not
  // treated as allowlisted.
  const safeSorts = parsed.sort.filter((s) =>
    Object.hasOwn(filterableColumns, s.id)
  );

  function applySorting(t: T) {
    const orderBy: ReturnType<typeof asc>[] = [];
    for (const s of safeSorts) {
      const col = getColumn(t, s.id);
      if (col) orderBy.push(s.desc ? desc(col) : asc(col));
    }
    // Deterministic tiebreaker: append the unique primary key so rows sharing
    // a sort value (low-cardinality columns like isActive/scope, or createdAt
    // stored at centisecond precision) keep a stable order across LIMIT/OFFSET
    // pages — without it a tied row can be skipped or shown twice between
    // pages. UUID v7 is time-sortable, so desc(id) aligns with the createdAt
    // desc default. Skipped if the caller already sorts by id.
    if (!safeSorts.some((s) => s.id === 'id')) {
      const idCol = getColumn(t, 'id');
      if (idCol) orderBy.push(desc(idCol));
    }
    return orderBy;
  }

  const offset = (parsed.page - 1) * safePerPage;

  return {
    where,
    orderBy: applySorting(table),
    limit: safePerPage,
    offset,
    page: parsed.page,
    perPage: safePerPage,
    search,
    buildPageCount: (total: number) =>
      Math.max(1, Math.ceil(total / safePerPage)),
  };
}
