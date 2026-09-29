import type { Column, ColumnSort } from '@tanstack/react-table';

import { DataTableFilterList } from './filters/data-table-filter-list';
import { DataTableSearch } from './filters/data-table-search';
import { DataTableSortList } from './filters/data-table-sort-list';
import { genericMemo } from './utils/generic-memo';
import { DataTableViewOptions } from './view-options';

interface DataTableToolbarProps<TData> {
  columns: Column<TData>[];
  defaultSort: ColumnSort[];
}

const DataTableToolbarInner = <TData,>({
  columns,
  defaultSort,
}: DataTableToolbarProps<TData>) => (
  <div
    role='toolbar'
    aria-orientation='horizontal'
    className='flex w-full items-center justify-start gap-2 p-1'
  >
    <DataTableSearch />
    <DataTableSortList
      columns={columns}
      defaultSort={defaultSort}
      align='start'
    />
    <DataTableFilterList columns={columns} align='start' />
    <div className='flex flex-1 justify-end'>
      <DataTableViewOptions columns={columns} />
    </div>
  </div>
);

const DataTableToolbar = genericMemo(DataTableToolbarInner, 'DataTableToolbar');

export { DataTableToolbar };
