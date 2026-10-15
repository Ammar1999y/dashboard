import type { EntityID } from '@app/shared/types';
import type { PaginationMeta } from '@app/shared/types/api';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';

import { replaceEqualDeep } from '@tanstack/react-query';

/**
 * Keys for one entity. Lists and details sit under separate segments so a list
 * update never reaches a detail entry: `list` is the prefix of both the full
 * list (`useQueryData`) and every server-table page (`useServerDataTable`
 * appends its page/sort/filter params).
 */
export const entityKeys = (scope: string) => ({
  all: [scope],
  list: [scope, 'list'],
  details: [scope, 'detail'],
  detail: (id: EntityID) => [scope, 'detail', id],
});

export type EntityKeys = ReturnType<typeof entityKeys>;

interface Row {
  id: EntityID;
}

/**
 * One page of a server-paged table, as `useServerDataTable` caches it. A page
 * may carry more than its rows (the media library's folders and breadcrumbs);
 * every write here keeps what it does not touch.
 */
export interface ServerPage<T> {
  data: T[];
  meta: PaginationMeta;
}

type CachedList<T> = T[] | ServerPage<T>;

/** `page` with `data` for its rows and `total` moved by `delta`. */
export const withTotal = <T, P extends ServerPage<T>>(
  page: P,
  data: T[],
  delta: number
): P => {
  const total = Math.max(0, page.meta.total + delta);
  return {
    ...page,
    data,
    meta: {
      ...page.meta,
      total,
      pageCount: Math.max(1, Math.ceil(total / page.meta.perPage)),
    },
  };
};

const mapRows = <T>(
  list: CachedList<T>,
  map: (rows: T[]) => T[]
): CachedList<T> =>
  Array.isArray(list) ? map(list) : { ...list, data: map(list.data) };

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && 'id' in value;

const isCachedList = (value: unknown): value is CachedList<unknown> =>
  Array.isArray(value) ||
  (typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    Array.isArray(value.data) &&
    'meta' in value);

/**
 * A patch is not a fetch: writing a query's data marks it fresh and clears its
 * stale mark, so the value keeps its age and its mark, or an entry marked for a
 * refetch would pass as current.
 */
export function writeKept(
  queryClient: QueryClient,
  query: Query,
  data: unknown
) {
  const { dataUpdatedAt, isInvalidated } = query.state;
  queryClient.setQueryData(query.queryKey, data, { updatedAt: dataUpdatedAt });
  if (isInvalidated) query.invalidate();
}

/**
 * Writes `update` to every cached query under `queryKey` whose data is a `T`
 * and that it changes. `setQueryData` writes even identical data, which would
 * make every entry the patch does not touch look freshly fetched, so an
 * unchanged one is not written at all, and a changed one keeps its age and mark
 * (`writeKept`). `exact` limits the match to the key itself.
 */
export function patchQueries<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  isData: (value: unknown) => value is T,
  update: (data: T) => T,
  { exact = false }: { exact?: boolean } = {}
) {
  const queries = queryClient.getQueryCache().findAll({ queryKey, exact });
  for (const query of queries) {
    const data = query.state.data;
    if (!isData(data)) continue;
    const next = replaceEqualDeep(data, update(data));
    if (next !== data) writeKept(queryClient, query, next);
  }
}

const patchLists = <T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  update: (list: CachedList<T>) => CachedList<T>
) =>
  patchQueries(
    queryClient,
    keys.list,
    (value): value is CachedList<T> => isCachedList(value),
    update
  );

const patchDetails = <T extends Row>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  update: (row: T) => T,
  exact: boolean
) =>
  patchQueries(
    queryClient,
    queryKey,
    (value): value is T => isRow(value),
    update,
    { exact }
  );

// A form leaves a disabled field `undefined` in its output (the slug on edit,
// for one); spreading that over the cached row would erase the stored value.
const merge = <T>(row: T, patch: Partial<T>): T => {
  const next = { ...row };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] !== undefined) next[key] = patch[key] as T[keyof T];
  }
  return next;
};

/*
 * The server answers a write with only what it generated — the id on create,
 * `updatedAt` on update, nothing on delete — so the cache is patched from the
 * data this client sent, and nothing here refetches. That includes server-table
 * pages, although the server's sort, filters and paging decide where a row
 * belongs: a written row stays where it was put until the page is next fetched.
 */

/** The row as this client holds it: its detail, or any list holding it. */
export function findCached<T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  id: EntityID
): T | undefined {
  const detail = queryClient.getQueryData<T>(keys.detail(id));
  if (detail) return detail;
  const lists = queryClient.getQueriesData<CachedList<T>>({
    queryKey: keys.list,
  });
  for (const [, list] of lists) {
    const rows = Array.isArray(list) ? list : list?.data;
    const row = rows?.find((r) => r.id === id);
    if (row) return row;
  }
  return undefined;
}

/**
 * For a detail that carries what the client could not write — a field the
 * list and the form lack. It refetches when next shown, not now.
 */
export const markDetailStale = (
  queryClient: QueryClient,
  keys: EntityKeys,
  id: EntityID
) =>
  void queryClient.invalidateQueries({
    queryKey: keys.detail(id),
    exact: true,
    refetchType: 'none',
  });

/** A created row: seeds its detail and heads every list and first page. */
export function cacheCreated<T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  row: T
) {
  queryClient.setQueryData(keys.detail(row.id), row);
  patchLists<T>(queryClient, keys, (list) => {
    if (Array.isArray(list)) return [row, ...list];
    const data =
      list.meta.page === 1
        ? [row, ...list.data].slice(0, list.meta.perPage)
        : list.data;
    return withTotal(list, data, 1);
  });
}

/** Merges `patch` into the row's detail and into every list holding it. */
export function cacheUpdated<T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  id: EntityID,
  patch: Partial<T>
) {
  patchDetails<T>(
    queryClient,
    keys.detail(id),
    (row) => merge(row, patch),
    true
  );
  patchLists<T>(queryClient, keys, (list) =>
    mapRows(list, (rows) =>
      rows.map((row) => (row.id === id ? merge(row, patch) : row))
    )
  );
}

/**
 * Rewrites every cached row of the entity — details and list rows — for a
 * change made elsewhere, such as a role renamed under the users that hold it.
 * `update` returns the same row when it has nothing to change.
 */
export function cacheUpdatedEach<T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  update: (row: T) => T
) {
  patchDetails<T>(queryClient, keys.details, update, false);
  patchLists<T>(queryClient, keys, (list) =>
    mapRows(list, (rows) => rows.map(update))
  );
}

/**
 * Drops the row from its detail and every list. A server page is left one row
 * short: the row that would move up from the next page is the server's.
 */
export function cacheRemoved<T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  id: EntityID
) {
  queryClient.removeQueries({ queryKey: keys.detail(id), exact: true });
  patchLists<T>(queryClient, keys, (list) => {
    if (Array.isArray(list)) return list.filter((row) => row.id !== id);
    if (!list.data.some((row) => row.id === id)) return list;
    return withTotal(
      list,
      list.data.filter((row) => row.id !== id),
      -1
    );
  });
}
