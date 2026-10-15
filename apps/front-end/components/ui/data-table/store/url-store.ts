import type { TableQuery } from '@/lib/data-table/query';
import type { JoinOperator } from '@app/shared/types/data-table';

import { useRouter } from 'next/router';
import { useLayoutEffect, useState } from 'react';

import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import {
  readTableQuery,
  sameSort,
  writeTableQuery,
} from '@/lib/data-table/url';
import { entryPage, mirrorPageParams } from '@/lib/history';

type Sort = TableQuery['sort'];
type Filters = TableQuery['filters'];

/** How long the table's changes must pause before the address is written. */
export const TABLE_URL_DELAY_MS = 300;

/**
 * Keeps an empty list's reference: a new `[]` is a change to every
 * subscriber of `filters`, and to every memo that depends on it.
 */
const emptied = (current: Filters): Filters =>
  current.length === 0 ? current : [];

/** Filters replace the quick search; clearing them leaves it. */
const withFilters = (current: Filters, filters: Filters) =>
  filters.length > 0
    ? { filters, search: '', page: 1 }
    : { filters: emptied(current), page: 1 };

interface DataTableIdentity {
  /** Which table the current state belongs to (`null` before the first mount). */
  tableKey: string | null;
}

interface DataTableActions {
  /**
   * Bind the store to one table and (re)load its state from the URL.
   *
   * The store is a module singleton that outlives client-side navigation, so
   * without this the next table page would inherit this one's filters, page
   * and search — sending a column the next endpoint rejects, or silently
   * filtering it on a shared id like `isActive`. A different identity resets
   * to that page's URL state; the same one is a no-op.
   */
  initTable: (tableKey: string, defaultSort?: Sort) => void;
  setPage: (page: number) => void;
  setPerPage: (perPage: number) => void;
  setSorting: (sort: Sort) => void;
  setFilters: (filters: Filters) => void;
  /** The filter panel's apply: its filters and how they combine, as one change. */
  applyFilters: (filters: Filters, joinOperator: JoinOperator) => void;
  setSearch: (search: string) => void;
}

export interface DataTableStore extends TableQuery, DataTableIdentity {
  actions: DataTableActions;
}

const parseUrlParams = (defaultSort: Sort = []): TableQuery =>
  readTableQuery(
    new URLSearchParams(typeof window === 'undefined' ? '' : location.search),
    defaultSort
  );

export const useDataTableStore = create<DataTableStore>((set) => ({
  ...parseUrlParams(),
  tableKey: null,

  actions: {
    initTable: (tableKey, defaultSort) =>
      set((s) =>
        s.tableKey === tableKey
          ? s
          : { ...parseUrlParams(defaultSort), tableKey }
      ),
    setPage: (page) => set({ page }),
    // A new page size or order makes the current page number meaningless.
    setPerPage: (perPage) => set({ perPage, page: 1 }),
    // Applying the order already shown still returns to the first page.
    setSorting: (sort) =>
      set((s) => ({ sort: sameSort(s.sort, sort) ? s.sort : sort, page: 1 })),
    setFilters: (filters) => set((s) => withFilters(s.filters, filters)),
    applyFilters: (filters, joinOperator) =>
      set((s) => ({ ...withFilters(s.filters, filters), joinOperator })),
    setSearch: (search) =>
      set((s) => ({ search, filters: emptied(s.filters), page: 1 })),
  },
}));

/**
 * This table page's URL state, bound to the route. Until `initTable` lands,
 * the singleton still holds the previous table's state after a client-side
 * navigation, so the page's own URL is read instead: without that, the first
 * request of the new table carries the old table's filters.
 *
 * The identity is one visit: the route, the history entry the table mounted
 * on, and Next's `asPath` for a navigation that keeps it mounted. Each visit
 * starts from its own URL, Back to an earlier one included, rather than from
 * the state of the visit before.
 */
export function useTableUrlState(defaultSort?: Sort): TableQuery {
  const { pathname, asPath } = useRouter();
  const [entry] = useState(entryPage);
  const key = `${pathname} ${asPath} ${entry}`;
  const stored = useDataTableStore(
    useShallow((s) => ({
      page: s.page,
      perPage: s.perPage,
      sort: s.sort,
      filters: s.filters,
      joinOperator: s.joinOperator,
      search: s.search,
      tableKey: s.tableKey,
    }))
  );

  useLayoutEffect(() => {
    useDataTableStore.getState().actions.initTable(key, defaultSort);
  }, [key, defaultSort]);

  return stored.tableKey === key ? stored : parseUrlParams(defaultSort);
}

/**
 * Mirrors the bound table's state into the address until the returned stop.
 * Runs after `initTable`, so it starts from this table's state.
 */
export function mirrorTableToUrl(defaultSort: Sort = []): () => void {
  const { tableKey } = useDataTableStore.getState();
  return mirrorPageParams({
    write: (params) => {
      const state = useDataTableStore.getState();
      // The next table binds the store in a layout effect, before this
      // mirror's passive cleanup stops it.
      if (state.tableKey === tableKey)
        writeTableQuery(params, state, defaultSort);
    },
    subscribe: useDataTableStore.subscribe,
    delayMs: TABLE_URL_DELAY_MS,
  });
}
