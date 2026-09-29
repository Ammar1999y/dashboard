import type { DataTableCta } from './page-header';
import type { EntityID } from '@/types';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';
import type {
  ColumnDef,
  ColumnPinningState,
  ColumnSort,
} from '@tanstack/react-table';

import { useMemo } from 'react';

import { queryRows } from '@/lib/data-table/query';

import { useQueryData, useServerDataTable } from '@/utils/query';
import { useTableUrlState } from '@/utils/store/data-table-store';

import { DataTableView } from './data-table-view';
import { DataTablePageHeader } from './page-header';
import { columnIdsOf, textColumnIds } from './utils/columns';
import { genericMemo } from './utils/generic-memo';

interface SourceProps<TData> {
  columns: ColumnDef<TData>[];
  queryKey: (string | number | EntityID)[];
  href: string;
  storageKey: string;
  defaultSort: ColumnSort[];
  defaultPinning?: ColumnPinningState;
}

/** The API pages, sorts and filters; one page is fetched per state. */
const ServerTableInner = <TData,>({
  queryKey,
  href,
  defaultSort,
  ...view
}: SourceProps<TData>) => {
  const state = useTableUrlState(defaultSort);
  const { data, meta, isLoading, error, refetch } = useServerDataTable<TData>({
    queryKey,
    href,
    state,
  });

  return (
    <DataTableView
      {...view}
      defaultSort={defaultSort}
      data={data}
      pageCount={meta.pageCount}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
    />
  );
};

const ServerTable = genericMemo(ServerTableInner, 'ServerDataTable');

/** The API returns the whole list; it is paged, sorted and filtered here, as the server would. */
const ClientTableInner = <TData extends object>({
  queryKey,
  href,
  defaultSort,
  ...view
}: SourceProps<TData>) => {
  const { page, perPage, sort, filters, joinOperator, search } =
    useTableUrlState(defaultSort);
  const { data, isLoading, error, refetch } = useQueryData<TData[]>({
    queryKey,
    href,
  });

  const searchFields = useMemo(
    () => textColumnIds(view.columns),
    [view.columns]
  );
  const result = useMemo(
    () =>
      data &&
      queryRows(
        data,
        { page, perPage, sort, filters, joinOperator, search },
        { searchFields }
      ),
    [data, page, perPage, sort, filters, joinOperator, search, searchFields]
  );

  return (
    <DataTableView
      {...view}
      defaultSort={defaultSort}
      data={result?.data}
      pageCount={result?.meta.pageCount ?? 1}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
    />
  );
};

const ClientTable = genericMemo(ClientTableInner, 'ClientDataTable');

const DEFAULT_SORT_COLUMN = 'createdAt';

interface DataTableProps<TData extends object> extends Omit<
  SourceProps<TData>,
  'defaultSort'
> {
  /** The API pages, sorts and filters; otherwise it returns the whole list. */
  serverSide?: boolean;
  title?: string;
  cta?: DataTableCta;
  /** Defaults to newest first when the table has a `createdAt` column. */
  defaultSort?: ExtendedColumnSort<TData>[];
}

const DataTableInner = <TData extends object>({
  serverSide = false,
  title,
  cta,
  defaultSort: defaultSortProp,
  ...source
}: DataTableProps<TData>) => {
  // Stable on purpose: it is a dependency of the URL-state init and of the
  // client-side query, so a new array per render would re-run both.
  const defaultSort = useMemo<ColumnSort[]>(() => {
    if (defaultSortProp) return defaultSortProp;
    return columnIdsOf(source.columns).includes(DEFAULT_SORT_COLUMN)
      ? [{ id: DEFAULT_SORT_COLUMN, desc: true }]
      : [];
  }, [defaultSortProp, source.columns]);
  // Picks one of two module-level components, not a component made during
  // render, so nothing remounts unless `serverSide` itself flips.
  const Table = serverSide ? ServerTable : ClientTable;

  return (
    <>
      {!!title && <DataTablePageHeader title={title} cta={cta} />}
      {/* The column store lives as long as the view: another table's key
          must remount it rather than reuse this table's layout. */}
      <Table key={source.storageKey} {...source} defaultSort={defaultSort} />
    </>
  );
};

const DataTable = genericMemo(DataTableInner, 'DataTable');

export { DataTable };
