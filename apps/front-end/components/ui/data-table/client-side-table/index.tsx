import type { EntityID } from '@/types';
import type { ExtendedColumnSort } from '@/types/data-table';
import type { ColumnDef, TableState } from '@tanstack/react-table';

import dynamic from 'next/dynamic';
import { useMemo, useRef } from 'react';

import { useQueryData } from '@/utils/query';

import { DataTableContent } from '@/components/ui/data-table';

import { useDataTable } from '../hooks/use-data-table';
import Header from './header';

const UrlSync = dynamic(
  () =>
    import('@/components/ui/data-table/filters/url-sync').then(
      (e) => e.UrlSync
    ),
  { ssr: false }
);
interface ClientSideTableProps<TData> {
  columns: ColumnDef<TData>[];
  queryKey: (string | number | EntityID)[];
  href: string;
  title?: string;
  cta?: { href: string; label: string };
  enabledQuery?: boolean;
  STORAGE_KEY: string;
  initialSorting?: ExtendedColumnSort<TData>[] | undefined;
}

function ClientSideTable<TData = unknown>({
  columns,
  queryKey,
  href,
  title,
  cta,
  enabledQuery = true,
  STORAGE_KEY,
  initialSorting,
}: ClientSideTableProps<TData>) {
  const queryParams = useMemo(
    () => ({
      queryKey,
      href,
      enabled: !!enabledQuery,
    }),
    [queryKey, href, enabledQuery]
  );

  const { data, isLoading, error, refetch } =
    useQueryData<TData[]>(queryParams);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const initialState:
    | (Omit<Partial<TableState>, 'sorting'> & {
        sorting?: ExtendedColumnSort<TData>[] | undefined;
      })
    | undefined = useMemo(
    () => ({
      sorting: initialSorting,
      columnPinning: {
        right: ['actions'],
      },
      columnVisibility: {},
      columnOrder: columns.flatMap((col) => (col.id ? [col.id] : [])),
    }),
    [initialSorting, columns]
  );
  const { table } = useDataTable({
    data: data || [],
    columns,
    pageCount: 1,
    storageKey: STORAGE_KEY,
    tableContainerRef,
    initialState,
  });

  return (
    <>
      <UrlSync defaultSort={initialSorting} />

      {!!title && <Header title={title} cta={cta} />}

      <DataTableContent
        table={table}
        data={data}
        isLoading={isLoading}
        error={error}
        refetch={refetch}
        tableContainerRef={tableContainerRef}
        STORAGE_KEY={STORAGE_KEY}
      />
    </>
  );
}

export default ClientSideTable;
