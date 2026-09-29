import type { LabRow } from './fake-server';
import type { DataTableHandle } from '@/components/ui/data-table';

import { useCallback, useEffect, useRef } from 'react';

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useTableUrlState } from '@/utils/store/data-table-store';

import { DataTableView } from '@/components/ui/data-table';

import { labColumns } from './columns';
import { fetchLabPage, LAB_QUERY_KEY } from './fake-server';
import { LAB_STORAGE_KEY, useLab } from './lab-store';

const LAB_DEFAULT_SORT = [{ id: 'createdAt', desc: true }];

// Mirrors the server-side `DataTable` source, with the fake server in place of the API.
export const LabTable = () => {
  const { page, perPage, sort, filters, joinOperator, search } =
    useTableUrlState(LAB_DEFAULT_SORT);
  const rootRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: [
      LAB_QUERY_KEY,
      page,
      perPage,
      sort,
      filters,
      joinOperator,
      search,
    ],
    queryFn: ({ signal }) =>
      fetchLabPage(
        {
          page,
          perPage,
          sort,
          search,
          filters: filters.map((f) => ({ id: f.id, value: f.value })),
        },
        signal
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const handleRef = useCallback((handle: DataTableHandle<LabRow> | null) => {
    useLab.setState(
      handle
        ? { table: handle.table, store: handle.store }
        : { table: null, store: null }
    );
  }, []);

  useEffect(() => {
    useLab.setState({ root: rootRef.current });
    return () => useLab.setState({ root: null });
  }, []);

  const { data, isLoading, error } = query;
  useEffect(() => {
    useLab.setState({
      status: {
        isLoading,
        hasError: !!error,
        dataLength: data?.data.length ?? 0,
        pageCount: data?.meta.pageCount ?? 1,
      },
    });
  }, [isLoading, error, data]);

  return (
    <div ref={rootRef}>
      <DataTableView
        ref={handleRef}
        columns={labColumns}
        data={data?.data}
        pageCount={data?.meta.pageCount ?? 1}
        isLoading={isLoading}
        error={error}
        refetch={query.refetch}
        storageKey={LAB_STORAGE_KEY}
        defaultSort={LAB_DEFAULT_SORT}
      />
    </div>
  );
};
