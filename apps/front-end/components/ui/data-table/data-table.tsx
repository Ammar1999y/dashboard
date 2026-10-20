import type { DataTableFeatures } from './features';
import type { DataTableCta } from './page-header';
import type { ClientEndpoint, PagedEndpoint } from '@/lib/api/client';
import type { PagedResponse } from '@app/shared/api/endpoint';
import type { EntityID } from '@app/shared/types';
import type { ExtendedColumnSort } from '@app/shared/types/data-table';
import type {
  ColumnDef,
  ColumnPinningState,
  ColumnSort,
  RowData,
} from '@tanstack/react-table';
import type * as z from 'zod';

import { useMemo } from 'react';

import { isPagedResponse } from '@app/shared/api/endpoint';
import { CustomError } from '@app/shared/error-class';
import { useEndpointQuery, useEndpointTable } from '@/lib/api/query';
import { queryRows } from '@/lib/data-table/query';

import { useTableUrlState } from '@/components/ui/data-table/store/url-store';

import { DataTableView } from './data-table-view';
import { DataTablePageHeader } from './page-header';
import { columnIdsOf, textColumnIds } from './utils/columns';
import { genericMemo } from './utils/generic-memo';

type Rows<T> = z.ZodType<T[]>;

type ListRead = ClientEndpoint & {
  readonly method: 'GET';
  readonly bodyKind: 'none';
};

/** A list the server pages, sorts and filters. */
type ServerList<T> = ListRead &
  PagedEndpoint & { readonly response: PagedResponse<Rows<T>> };

/** A list the server answers whole. */
type WholeList<T> = ListRead & { readonly response: Rows<T> };

const isServerList = <T,>(
  endpoint: ServerList<T> | WholeList<T>
): endpoint is ServerList<T> => isPagedResponse(endpoint.response);

interface SourceProps<TData extends RowData, E> {
  columns: ColumnDef<DataTableFeatures, TData>[];
  queryKey: (string | number | EntityID)[];
  /** The rows' read, which types and checks them. */
  endpoint: E;
  storageKey: string;
  defaultSort: ColumnSort[];
  defaultPinning?: ColumnPinningState;
}

/** The API pages, sorts and filters; one page is fetched per state. */
const ServerTableInner = <TData extends RowData>({
  queryKey,
  endpoint,
  defaultSort,
  ...view
}: SourceProps<TData, ServerList<TData>>) => {
  const state = useTableUrlState(defaultSort);
  const { data, meta, isLoading, error, refetch } = useEndpointTable<
    ServerList<TData>,
    TData
  >(endpoint, undefined, { queryKey, state });

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
  endpoint,
  defaultSort,
  ...view
}: SourceProps<TData, WholeList<TData>>) => {
  const { page, perPage, sort, filters, joinOperator, search } =
    useTableUrlState(defaultSort);
  const { data, isLoading, error, refetch } = useEndpointQuery<
    WholeList<TData>,
    TData[]
  >(endpoint, undefined, { queryKey });

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
  SourceProps<TData, ServerList<NoInfer<TData>> | WholeList<NoInfer<TData>>>,
  'defaultSort'
> {
  title?: string;
  cta?: DataTableCta;
  /** Defaults to newest first when the table has a `createdAt` column. */
  defaultSort?: ExtendedColumnSort<TData>[];
}

const DataTableInner = <TData extends object>({
  endpoint,
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
  return (
    <>
      {!!title && <DataTablePageHeader title={title} cta={cta} />}
      {/* The column store lives as long as the view: another table's key
          must remount it rather than reuse this table's layout. The source is
          one of two module-level components, picked by whether the server
          pages the list. */}
      {isServerList(endpoint) ? (
        <ServerTable
          key={source.storageKey}
          {...source}
          endpoint={endpoint}
          defaultSort={defaultSort}
        />
      ) : (
        <ClientTable
          key={source.storageKey}
          {...source}
          endpoint={endpoint}
          defaultSort={defaultSort}
        />
      )}
    </>
  );
};

const DataTable = genericMemo(DataTableInner, 'DataTable');

export { DataTable };
