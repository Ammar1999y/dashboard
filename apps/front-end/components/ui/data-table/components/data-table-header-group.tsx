import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { useShallow } from 'zustand/react/shallow';

import {
  useColumnOrder,
  useColumnPinning,
  useColumnVisibility,
} from '../store';
import { DataTableHeaderRow } from './data-table-header-row';

interface DataTableHeaderGroupProps<TData = unknown> {
  table: Table<TData>;
  activeIndex: number;
}

const DataTableHeaderGroupInner = <TData,>({
  table,
  activeIndex,
}: DataTableHeaderGroupProps<TData>) => {
  useColumnVisibility(useShallow((s) => s.columnVisibility));
  useColumnPinning(useShallow((s) => s.columnPinning));
  useColumnOrder((s) => s.columnOrder);
  return table
    .getHeaderGroups()
    .map((headerGroup) => (
      <DataTableHeaderRow
        key={headerGroup.id}
        headerGroup={headerGroup}
        activeIndex={activeIndex}
      />
    ));
};

const DataTableHeaderGroup = memo(DataTableHeaderGroupInner) as <TData>(
  props: DataTableHeaderGroupProps<TData>
) => React.ReactElement | null;

export { DataTableHeaderGroup };
