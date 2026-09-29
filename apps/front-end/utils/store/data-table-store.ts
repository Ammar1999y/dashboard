import type { TableQuery } from '@/lib/data-table/query';
import type {
  ExtendedColumnFilter,
  ExtendedColumnSort,
  JoinOperator,
} from '@app/shared/types/data-table';

import { useRouter } from 'next/router';
import { useLayoutEffect } from 'react';

import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import {
  DEFAULT_PER_PAGE,
  MAX_PAGE,
  MAX_PER_PAGE,
  parseFiltersState,
  parseSortingState,
} from '@app/shared/data-table/parsers';

import { positiveInt } from '..';

export const URL_KEYS = {
  page: 'page',
  perPage: 'perPage',
  sort: 'sort',
  filters: 'filters',
  joinOperator: 'joinOperator',
  search: 'search',
} as const;

type Sort = ExtendedColumnSort<Record<string, unknown>>[];

export type DataTableState = TableQuery;

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
  setFilters: (
    filters:
      | ExtendedColumnFilter<Record<string, unknown>>[]
      | null
      | ((
          prev: ExtendedColumnFilter<Record<string, unknown>>[]
        ) => ExtendedColumnFilter<Record<string, unknown>>[])
  ) => void;
  setJoinOperator: (joinOperator: JoinOperator) => void;
  setSearch: (search: string) => void;
}

export interface DataTableStore extends DataTableState, DataTableIdentity {
  actions: DataTableActions;
}

function parseUrlParams(defaultSort: Sort = []): DataTableState {
  if (typeof window === 'undefined') {
    return {
      page: 1,
      perPage: DEFAULT_PER_PAGE,
      sort: defaultSort,
      filters: [],
      joinOperator: 'and',
      search: '',
    };
  }

  const params = new URLSearchParams(location.search);

  const page = positiveInt(params.get(URL_KEYS.page), MAX_PAGE) || 1;
  const perPage =
    positiveInt(params.get(URL_KEYS.perPage), MAX_PER_PAGE) || DEFAULT_PER_PAGE;

  const parsedSort = parseSortingState(params.get(URL_KEYS.sort));
  const sort = parsedSort.length > 0 ? parsedSort : defaultSort;
  const filters = parseFiltersState(params.get(URL_KEYS.filters));
  const joinOperatorRaw = params.get(URL_KEYS.joinOperator);
  const joinOperator: JoinOperator = joinOperatorRaw === 'or' ? 'or' : 'and';

  const searchRaw = params.get(URL_KEYS.search);
  // If both filters and search exist in URL, prioritize filters and discard search
  const search = filters.length > 0 ? '' : (searchRaw ?? '');

  return { page, perPage, sort, filters, joinOperator, search };
}

export const useDataTableStore = create<DataTableStore>((set, get) => ({
  ...parseUrlParams(),
  tableKey: null,

  actions: {
    initTable: (tableKey, defaultSort) => {
      if (get().tableKey === tableKey) return;
      set({ ...parseUrlParams(defaultSort), tableKey });
    },
    setPage: (page) => set({ page }),
    // A new page size or order makes the current page number meaningless.
    setPerPage: (perPage) => set({ perPage, page: 1 }),
    setSorting: (sort) => set({ sort, page: 1 }),
    setFilters: (filtersOrUpdater) => {
      if (filtersOrUpdater === null) {
        set({ filters: [], page: 1 });
        return;
      }
      const filters =
        typeof filtersOrUpdater === 'function'
          ? filtersOrUpdater(get().filters)
          : filtersOrUpdater;
      set({
        filters,
        search: filters.length > 0 ? '' : get().search,
        page: 1,
      });
    },
    setJoinOperator: (joinOperator) => set({ joinOperator }),
    setSearch: (search) => set({ search, filters: [], page: 1 }),
  },
}));

/**
 * This table page's URL state, bound to the route. Until `initTable` lands,
 * the singleton still holds the previous table's state after a client-side
 * navigation, so the page's own URL is read instead: without that, the first
 * request of the new table carries the old table's filters.
 */
export function useTableUrlState(defaultSort?: Sort): DataTableState {
  const { pathname } = useRouter();
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
    useDataTableStore.getState().actions.initTable(pathname, defaultSort);
  }, [pathname, defaultSort]);

  return stored.tableKey === pathname ? stored : parseUrlParams(defaultSort);
}
