import type { DataTableFeatures } from '../features';
import type { TableLayout } from '../hooks/use-table-instance';
import type { Header, HeaderGroup, RowData } from '@tanstack/react-table';

import { useMemo } from 'react';

import {
  horizontalListSortingStrategy,
  SortableContext,
} from '@dnd-kit/sortable';

import { genericMemo } from '../utils/generic-memo';
import { DataTableHeaderCell } from './header-cell';

interface HeaderRowProps<TData extends RowData> {
  headers: Header<DataTableFeatures, TData>[];
  pins: TableLayout<TData>['pins'];
}

const HeaderRowInner = <TData extends RowData>({
  headers,
  pins,
}: HeaderRowProps<TData>) => {
  const columnIds = useMemo(
    () => headers.map((header) => header.column.id),
    [headers]
  );

  return (
    <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
      <div data-slot='table-row' className='flex min-h-10 w-fit'>
        {headers.map((header) => {
          const pin = pins[header.column.id];
          return (
            <DataTableHeaderCell
              key={header.id}
              header={header}
              pinSide={pin?.side}
              pinEdge={pin?.edge ?? false}
            />
          );
        })}
      </div>
    </SortableContext>
  );
};

const HeaderRow = genericMemo(HeaderRowInner, 'DataTableHeaderRow');

interface DataTableHeaderProps<TData extends RowData> {
  headerGroups: HeaderGroup<DataTableFeatures, TData>[];
  layout: TableLayout<TData>;
}

const DataTableHeaderInner = <TData extends RowData>({
  headerGroups,
  layout,
}: DataTableHeaderProps<TData>) =>
  headerGroups.map((headerGroup) => (
    <HeaderRow
      key={headerGroup.id}
      headers={headerGroup.headers}
      pins={layout.pins}
    />
  ));

const DataTableHeader = genericMemo(DataTableHeaderInner, 'DataTableHeader');

export { DataTableHeader };
