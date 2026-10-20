import type { DataTableFeatures } from '../features';
import type { PinSide } from '../store/column-store';
import type { Header, RowData } from '@tanstack/react-table';
import type { KeyboardEvent } from 'react';

import { memo, useCallback, useMemo } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { flexRender } from '@tanstack/react-table';
import { cn } from '@/lib/utils';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';
import { Icon } from '@/components/ui/icon';

import { Button } from '../../button';
import { LabelTooltip } from '../../tooltip';
import { ColumnFilterPopover } from '../filters/column-filter-popover';
import { useColumnActions } from '../store/context';
import { stopDragStart } from '../utils/events';
import { genericMemo } from '../utils/generic-memo';
import { HeaderOptions } from './header-options';
import { cellAttributes } from './table-elements';

type SortDirection = 'asc' | 'desc';

const SortButton = memo(({ columnId }: { columnId: string }) => {
  const direction = useDataTableStore((s): SortDirection | undefined => {
    const current = s.sort.find((sort) => sort.id === columnId);
    if (!current) return undefined;
    return current.desc ? 'desc' : 'asc';
  });

  // Unsorted and descending both go to ascending: removing a sort is disabled.
  const handleSort = useCallback(() => {
    const { sort, actions } = useDataTableStore.getState();
    const current = sort.find((s) => s.id === columnId);
    actions.setSorting([{ id: columnId, desc: current?.desc === false }]);
  }, [columnId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      handleSort();
    },
    [handleSort]
  );

  return (
    <LabelTooltip label={direction === 'asc' ? 'ترتيب تنازلي' : 'ترتيب تصاعدي'}>
      <Button
        type='button'
        variant='ghost'
        className={cn(
          'h-7 w-7 shrink-0 rounded bg-accent p-1 text-accent-foreground transition-opacity duration-200',
          direction
            ? 'opacity-100'
            : 'opacity-0 hover:!opacity-100 group-hover/header:opacity-80 touch:opacity-80'
        )}
        data-sort={direction ?? 'none'}
        onClick={handleSort}
        onKeyDown={handleKeyDown}
        onPointerDown={stopDragStart}
      >
        {direction === undefined && (
          <Icon icon='solar:sort-vertical-linear' className='size-4' />
        )}
        {direction === 'asc' && (
          <Icon icon='solar:arrow-up-linear' className='size-4' />
        )}
        {direction === 'desc' && (
          <Icon icon='solar:arrow-down-linear' className='size-4' />
        )}
      </Button>
    </LabelTooltip>
  );
});

SortButton.displayName = 'SortButton';

enum InsertPosition {
  Before = -1,
  After = 1,
}

interface HeaderCellProps<TData extends RowData> {
  header: Header<DataTableFeatures, TData>;
  pinSide: PinSide | undefined;
  pinEdge: boolean;
}

const HeaderCellInner = <TData extends RowData>({
  header,
  pinSide,
  pinEdge,
}: HeaderCellProps<TData>) => {
  const actions = useColumnActions();
  const { column } = header;
  const columnId = column.id;
  const isOrderingEnabled = column.columnDef.meta?.enableOrdering ?? true;
  const canSort = column.getCanSort();
  const canFilter = column.getCanFilter();
  const canPin = column.getCanPin();
  const canHide = column.getCanHide();
  const canResize = column.getCanResize();
  const hasOptions = canSort || canPin || canHide;

  const {
    attributes,
    listeners,
    index,
    activeIndex,
    isDragging,
    isSorting,
    over,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: columnId, disabled: !isOrderingEnabled });

  const style = useMemo(
    () => ({
      transition,
      transform: isSorting ? undefined : CSS.Translate.toString(transform),
    }),
    [transition, isSorting, transform]
  );

  const insertPosition =
    !isDragging && activeIndex !== -1 && over?.id === columnId
      ? index >= activeIndex
        ? InsertPosition.After
        : InsertPosition.Before
      : undefined;

  const dragProps = isOrderingEnabled
    ? { ...attributes, ...listeners }
    : undefined;

  const handleResetSize = useCallback(
    () => actions.resetSize(columnId),
    [actions, columnId]
  );
  const resizeHandler = header.getResizeHandler();

  return (
    <div
      data-slot='table-head'
      className={cn(
        'group/header relative flex min-h-10 select-none flex-col content-center justify-center p-2 align-middle font-medium text-foreground transition-shadow duration-300 touch:justify-between',
        isDragging && 'z-[1] opacity-50',
        isOrderingEnabled && 'cursor-grab active:cursor-grabbing',
        insertPosition !== undefined &&
          "after:absolute after:bottom-0 after:top-0 after:w-0.5 after:bg-primary after:content-['']",
        insertPosition === InsertPosition.Before &&
          'ltr:after:left-0.5 rtl:after:right-0.5',
        insertPosition === InsertPosition.After &&
          'ltr:after:right-0.5 rtl:after:left-0.5'
      )}
      style={style}
      ref={setNodeRef}
      {...cellAttributes(columnId, pinSide, pinEdge)}
      {...dragProps}
    >
      {header.isPlaceholder
        ? null
        : flexRender(column.columnDef.header, header.getContext())}

      {(canFilter || hasOptions) && (
        <div className='me-1 flex items-center gap-0.5 self-end hover-device:absolute hover-device:top-1/2 hover-device:me-0 hover-device:-translate-y-1/2 hover-device:self-auto ltr:hover-device:right-3 rtl:hover-device:left-3'>
          {canFilter && <ColumnFilterPopover column={column} />}
          {canSort && <SortButton columnId={columnId} />}
          {hasOptions && (
            <HeaderOptions
              columnId={columnId}
              canSort={canSort}
              canPin={canPin}
              canOrder={isOrderingEnabled}
              canResize={canResize}
              canHide={canHide}
            />
          )}
        </div>
      )}

      {canResize && (
        <button
          tabIndex={-1}
          type='button'
          onPointerDown={stopDragStart}
          onDoubleClick={handleResetSize}
          onMouseDown={resizeHandler}
          onTouchStart={resizeHandler}
          className='noSelect resize-handler absolute top-1/2 h-4/6 w-1 -translate-y-1/2 cursor-col-resize rounded bg-border opacity-50 !outline-0 transition-all duration-300 hover:opacity-100 active:bg-primary active:opacity-100'
          aria-label='مقبض تغيير حجم العمود'
        />
      )}
    </div>
  );
};

const DataTableHeaderCell = genericMemo(HeaderCellInner, 'DataTableHeaderCell');

export { DataTableHeaderCell };
