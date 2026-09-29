import type { EntityID } from '@/types';
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

const isServerPage = (data: unknown): data is ServerPage<unknown> =>
  typeof data === 'object' &&
  data !== null &&
  !Array.isArray(data) &&
  'meta' in data;

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
 * data this client sent. Nothing here refetches.
 */

/**
 * A created row: seeds its detail and heads every full list. A server-table
 * page is only marked stale, because where the row lands — and the page
 * totals — depend on sorting, filters and pagination the server applies. It
 * refetches when a table next mounts, not now.
 */
export function cacheCreated<T extends Row>(
  queryClient: QueryClient,
  keys: EntityKeys,
  row: T
) {
  queryClient.setQueryData(keys.detail(row.id), row);
  queryClient.setQueriesData<CachedList<T>>({ queryKey: keys.list }, (list) =>
    Array.isArray(list) ? [row, ...list] : list
  );
  void queryClient.invalidateQueries({
    queryKey: keys.list,
    refetchType: 'none',
    predicate: (query) => isServerPage(query.state.data),
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
 * Drops the row from its detail and every list, at once. A server page is the
 * one case that fetches: the row that should move up from the next page exists
 * only on the server, so the page on screen is refetched and the others are
 * marked stale for when they are next shown.
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

    const total = Math.max(0, list.meta.total - 1);
    return {
      data: list.data.filter((row) => row.id !== id),
      meta: {
        ...list.meta,
        total,
        pageCount: Math.max(1, Math.ceil(total / list.meta.perPage)),
      },
    };
  });
  void queryClient.invalidateQueries({
    queryKey: keys.list,
    predicate: (query) => isServerPage(query.state.data),
  });
}
