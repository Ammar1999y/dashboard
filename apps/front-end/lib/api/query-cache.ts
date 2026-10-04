import type { EntityID } from '@app/shared/types';
import type { PaginationMeta } from '@app/shared/types/api';
import type { QueryClient } from '@tanstack/react-query';

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

/** One page of a server-paged table, as `useServerDataTable` caches it. */
export interface ServerPage<T> {
  data: T[];
  meta: PaginationMeta;
}

type CachedList<T> = T[] | ServerPage<T>;

const withTotal = <T>(
  page: ServerPage<T>,
  data: T[],
  delta: number
): ServerPage<T> => {
  const total = Math.max(0, page.meta.total + delta);
  return {
    data,
    meta: {
      ...page.meta,
      total,
      pageCount: Math.max(1, Math.ceil(total / page.meta.perPage)),
    },
  };
};

const mapRows = <T>(
  list: CachedList<T> | undefined,
  map: (rows: T[]) => T[]
): CachedList<T> | undefined => {
  if (!list) return list;
  return Array.isArray(list) ? map(list) : { ...list, data: map(list.data) };
};

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
  queryClient.setQueriesData<CachedList<T>>({ queryKey: keys.list }, (list) => {
    if (!list) return list;
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
  queryClient.setQueryData<T>(
    keys.detail(id),
    (row) => row && merge(row, patch)
  );
  queryClient.setQueriesData<CachedList<T>>({ queryKey: keys.list }, (list) =>
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
  queryClient.setQueriesData<T>(
    { queryKey: keys.details },
    (row) => row && update(row)
  );
  queryClient.setQueriesData<CachedList<T>>({ queryKey: keys.list }, (list) =>
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
  queryClient.setQueriesData<CachedList<T>>({ queryKey: keys.list }, (list) => {
    if (!list) return list;
    if (Array.isArray(list)) return list.filter((row) => row.id !== id);
    if (!list.data.some((row) => row.id === id)) return list;
    return withTotal(
      list,
      list.data.filter((row) => row.id !== id),
      -1
    );
  });
}
