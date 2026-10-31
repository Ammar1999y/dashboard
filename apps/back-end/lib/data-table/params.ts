import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';
import type { DataTableQuery } from '@app/shared/data-table/query';
import type { PaginationMeta } from '@app/shared/types/api';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';
import type { SQL, Table } from 'drizzle-orm';

import { and, asc, desc, ilike, or } from 'drizzle-orm';

import { invalidFilter } from '@app/shared/data-table/filter-rules';
import {
  effectiveSearchTerm,
  parseSearchParams,
} from '@app/shared/data-table/parsers';

import {
  filterColumns,
  foldedColumn,
  getColumn,
  searchPattern,
} from './filter-columns';

interface DataTableQueryParams<T extends Table> {
  /**
   * The query as `bind()` validated it, which already refused an unknown or
   * repeated key. A route's own keys beside these are not read.
   */
  query: DataTableQuery;
  /**
   * Server-owned descriptors for every filterable/sortable column. Its keys
   * ARE the allowlist — a column with no descriptor can be neither filtered
   * nor sorted, and an unknown one is rejected rather than dropped.
   */
  filterableColumns: FilterColumnSpecs;
  /** Columns to match against for quick search (?search=) */
  searchableColumns?: readonly Extract<keyof T['_']['columns'], string>[];
  defaultSort?: ExtendedColumnSort<T>;
}

interface DataTableQueryResult {
  where: SQL | undefined;
  orderBy: ReturnType<typeof asc>[];
  limit: number;
  offset: number;
  /**
   * The quick-search term as typed, after normalisation and the length bounds;
   * `''` when there is none. Not folded: a match goes through `searchPattern`.
   */
  search: string;
  /** The response `meta` for a list of `total` rows. */
  paginationMeta: (total: number) => PaginationMeta;
}

export function parseDataTableParams<T extends Table>(
  table: T,
  {
    query,
    filterableColumns,
    searchableColumns,
    defaultSort,
  }: DataTableQueryParams<T>
): DataTableQueryResult {
  // A filter the parser could not read is a client error, not a filter to
  // ignore: dropping it silently broadens an `and` query and narrows an `or`
  // one, so the caller gets rows they never asked for with a 200.
  const parsed = parseSearchParams<T>(query, {
    defaultSort,
    // The allowlist, handed to the parser rather than applied to its output:
    // its `defaultSort` fallback has to run AFTER unknown ids are dropped, or a
    // sort naming a column outside this map takes the handler's declared
    // ordering with it and leaves only the primary-key tiebreaker.
    sortableColumnIds: Object.keys(filterableColumns),
    onFilterDropped: () => invalidFilter(),
  });

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
  const search = effectiveSearchTerm(query.search ?? '');

  let searchWhere: SQL | undefined;
  if (search && searchableColumns?.length) {
    const pattern = searchPattern(search, 'contains');
    const conditions: SQL[] = [];
    for (const colName of searchableColumns) {
      const col = getColumn(table, colName);
      if (!col)
        throw new Error(`Searchable column "${colName}" is not on the table`);
      conditions.push(ilike(foldedColumn(col), pattern));
    }
    searchWhere = or(...conditions);
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

  const { page, perPage } = parsed;

  return {
    where,
    orderBy: applySorting(table),
    limit: perPage,
    offset: (page - 1) * perPage,
    search,
    paginationMeta: (total: number) => ({
      page,
      perPage,
      total,
      pageCount: Math.max(1, Math.ceil(total / perPage)),
    }),
  };
}
