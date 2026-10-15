import type { DataTableCta } from './page-header';
import type { EntityID } from '@app/shared/types';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';
import type {
  ColumnDef,
  ColumnPinningState,
  ColumnSort,
} from '@tanstack/react-table';
import type * as z from 'zod';

import { useMemo } from 'react';

import { CustomError } from '@app/shared/error-class';
import { useQueryData, useServerDataTable } from '@/lib/api/query';
import { queryRows } from '@/lib/data-table/query';

import { useTableUrlState } from '@/components/ui/data-table/store/url-store';

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
  /** The rows' array schema, which the response is checked against. */
  schema: z.ZodType<NoInfer<TData>[]>;
}

/** The API pages, sorts and filters; one page is fetched per state. */
const ServerTableInner = <TData,>({
  queryKey,
  href,
  schema,
  defaultSort,
  ...view
}: SourceProps<TData>) => {
  const state = useTableUrlState(defaultSort);
  const { data, meta, isLoading, error, refetch } = useServerDataTable({
    queryKey,
    href,
    state,
    schema,
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
  schema,
  defaultSort,
  ...view
}: SourceProps<TData>) => {
  const { page, perPage, sort, filters, joinOperator, search } =
    useTableUrlState(defaultSort);
  const { data, isLoading, error, refetch } = useQueryData({
    queryKey,
    href,
    schema,
  });

  const searchableColumns = useMemo(
    () => textColumnIds(view.columns),
    [view.columns]
  );
  // A filter the server would refuse with a 422 shows that error here too.
  const result = useMemo(() => {
    if (!data) return;
    try {
      const rows = queryRows(
        data,
        { page, perPage, sort, filters, joinOperator, search },
        { searchableColumns }
      );
      return { rows, refusal: null };
    } catch (refusal) {
      if (refusal instanceof CustomError) return { rows: undefined, refusal };
      throw refusal;
    }
  }, [
    data,
    page,
    perPage,
    sort,
    filters,
    joinOperator,
    search,
    searchableColumns,
  ]);

  return (
    <DataTableView
      {...view}
      defaultSort={defaultSort}
      data={result?.rows?.data}
      pageCount={result?.rows?.meta.pageCount ?? 1}
      isLoading={isLoading}
      error={error ?? result?.refusal ?? null}
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
