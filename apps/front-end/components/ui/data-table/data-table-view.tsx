import type { ColumnStore } from './store/column-store';
import type { DropAnimation, MeasuringConfiguration } from '@dnd-kit/core';
import type {
  ColumnDef,
  ColumnPinningState,
  ColumnSort,
  Table,
} from '@tanstack/react-table';
import type { Ref } from 'react';

import dynamic from 'next/dynamic';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';

import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';

import { ACTIONS_COLUMN } from './column-presets';
import { DataTableBody } from './components/body';
import { ColumnRules } from './components/column-rules';
import { DataTableHeader } from './components/header';
import { useColumnDnd } from './hooks/use-column-dnd';
import { useTableInstance } from './hooks/use-table-instance';
import { DataTablePagination } from './pagination';
import { PaginationSkeleton } from './pagination-skeleton';
import { createColumnStore, persistColumnStore } from './store/column-store';
import { ColumnStoreContext, useColumnStoreApi } from './store/context';
import { DataTableToolbar } from './toolbar';
import { ToolbarSkeleton } from './toolbar-skeleton';
import { columnIdsOf } from './utils/columns';
import { genericMemo } from './utils/generic-memo';

const UrlSync = dynamic(
  () => import('./filters/url-sync').then((module) => module.UrlSync),
  { ssr: false }
);

const MEASURING: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.Always },
};

const DROP_ANIMATION: DropAnimation = {
  keyframes({ transform }) {
    return [
      { transform: CSS.Transform.toString(transform.initial) },
      {
        transform: CSS.Transform.toString({
          scaleX: 0.98,
          scaleY: 0.98,
          x: transform.final.x - 10,
          y: transform.final.y + 10,
        }),
        opacity: 0,
      },
    ];
  },
  sideEffects: defaultDropAnimationSideEffects({
    className: { active: 'opacity-100' },
  }),
};

// Not `data ?? []`: a new array each render is new data to TanStack, which
// rebuilds every row and defeats the row memo while the first page loads.
const NO_ROWS: never[] = [];

/** Exposes the instance and its column store, for diagnostics. */
export interface DataTableHandle<TData> {
  table: Table<TData>;
  store: ColumnStore;
}

interface DataTableViewProps<TData> {
  columns: ColumnDef<TData>[];
  /** The current page of rows; `undefined` until the first response. */
  data: TData[] | undefined;
  pageCount: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  /** Saves the column layout; a table remounted under another key starts over. */
  storageKey: string;
  defaultSort: ColumnSort[];
  /** Defaults to the `actions` column pinned to the end, when there is one. */
  defaultPinning?: ColumnPinningState;
  ref?: Ref<DataTableHandle<TData>>;
}

// A page past the last one (a stale URL, or rows deleted from the last page)
// is moved back once the page count is known; pagination itself is hidden
// then, so nothing else would.
function useClampedPage(pageCount: number, isLoading: boolean) {
  const page = useDataTableStore((s) => s.page);
  useEffect(() => {
    if (!isLoading && page > pageCount)
      useDataTableStore.getState().actions.setPage(Math.max(1, pageCount));
  }, [isLoading, page, pageCount]);
}

const DragLabel = ({ label }: { label: string }) => (
  <div className='flex min-h-10 max-w-32 translate-x-2.5 translate-y-2.5 animate-dnd-pop cursor-grabbing items-center rounded bg-card p-2 text-foreground shadow-lg'>
    {label}
  </div>
);

const TableFrameInner = <TData,>({
  columns,
  data,
  pageCount,
  isLoading,
  error,
  refetch,
  defaultSort,
  ref,
}: DataTableViewProps<TData>) => {
  const store = useColumnStoreApi();
  const {
    table,
    headerGroups,
    layout,
    bodyRows,
    columnRules,
    tableWidth,
    allColumns,
  } = useTableInstance(columns, data ?? NO_ROWS);
  const {
    activeId,
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  } = useColumnDnd();
  const tableId = useId();

  useImperativeHandle(ref, () => ({ table, store }), [table, store]);
  useClampedPage(pageCount, isLoading);

  const activeLabel = useMemo(() => {
    const column = allColumns.find((c) => c.id === activeId);
    return column ? (column.columnDef.meta?.label ?? column.id) : null;
  }, [activeId, allColumns]);

  return (
    <DndContext
      id={tableId}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={MEASURING}
    >
      <UrlSync defaultSort={defaultSort} />
      <div
        className={cn(
          'relative transition-opacity duration-300 space-y-4',
          isLoading && 'pointer-events-none select-none opacity-50'
        )}
        inert={isLoading}
      >
        {isLoading ? (
          <ToolbarSkeleton />
        ) : (
          <DataTableToolbar columns={allColumns} defaultSort={defaultSort} />
        )}
        <div
          data-slot='table-container'
          data-lenis-prevent
          className='relative max-h-[70vh] w-full overflow-x-auto rounded-md text-sm'
        >
          <ColumnRules tableId={tableId} rules={columnRules} />
          <div
            data-slot='table'
            data-table-id={tableId}
            style={{ width: tableWidth }}
          >
            {/* z-20: above pinned body cells, which `styles/table.css` gives
                z-index 10 so they cover the columns scrolling under them. */}
            <div
              data-slot='table-header'
              className='sticky top-0 z-20 rounded-t-lg bg-background'
            >
              <div className='rounded-t-lg bg-muted/70'>
                <DataTableHeader headerGroups={headerGroups} layout={layout} />
              </div>
            </div>
            <div data-slot='table-body'>
              <DataTableBody
                bodyRows={bodyRows}
                layout={layout}
                isLoading={isLoading}
                error={error}
                refetch={refetch}
              />
            </div>
          </div>
        </div>
        {isLoading ? (
          <PaginationSkeleton />
        ) : bodyRows.length > 0 ? (
          <DataTablePagination pageCount={pageCount} />
        ) : null}
      </div>
      <DragOverlay dropAnimation={DROP_ANIMATION}>
        {activeLabel === null ? null : <DragLabel label={activeLabel} />}
      </DragOverlay>
    </DndContext>
  );
};

const TableFrame = genericMemo(TableFrameInner, 'DataTableFrame');

/**
 * The table for rows the caller already has. Owns one column store for its
 * lifetime: remount it (a `key`) to switch to another table's layout.
 */
function DataTableView<TData>(props: DataTableViewProps<TData>) {
  const { columns, storageKey, defaultPinning } = props;
  // A store per mounted table, created in a `useState` initializer: not a
  // module singleton (one table's unmount used to wipe the next table's
  // layout), and not `useMemo` (React may drop a memo; this must live exactly
  // as long as the table). Later prop changes are ignored — remount instead.
  const [{ store, defaults }] = useState(() => {
    const columnIds = columnIdsOf(columns);
    const initialLayout = {
      columnOrder: columnIds,
      columnVisibility: {},
      columnPinning: defaultPinning ?? {
        left: [],
        right: columnIds.includes(ACTIONS_COLUMN) ? [ACTIONS_COLUMN] : [],
      },
      columnSizing: {},
    };
    return {
      store: createColumnStore(storageKey, columnIds, initialLayout),
      defaults: initialLayout,
    };
  });

  useEffect(
    () => persistColumnStore(store, storageKey, defaults),
    [store, storageKey, defaults]
  );

  return (
    <ColumnStoreContext.Provider value={store}>
      <TableFrame {...props} />
    </ColumnStoreContext.Provider>
  );
}

export { DataTableView };
