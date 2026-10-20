import type { DataTableFeatures } from '../features';
import type {
  Column,
  ColumnSort,
  RowData,
  SortDirection,
} from '@tanstack/react-table';
import type { ComponentProps, KeyboardEvent } from 'react';

import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';

import { dataTableConfig } from '@app/shared/data-table/config';
import {
  MSG_EDIT_SORT,
  MSG_FIND_FIELD,
  MSG_NO_FIELDS,
  MSG_NO_SORT,
} from '@/constants/messages';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDataTableStore } from '@/components/ui/data-table/store/url-store';
import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from '@/components/ui/sortable';

import {
  REMOVE_ITEM_SHORTCUTS,
  usePopoverShortcut,
} from '../hooks/use-popover-shortcut';

const SORT_SHORTCUT_KEY = 'j';

const getSortItemValue = (item: ColumnSort) => item.id;

interface DataTableSortListProps<TData extends RowData> extends ComponentProps<
  typeof PopoverContent
> {
  columns: Column<DataTableFeatures, TData>[];
  defaultSort: ColumnSort[];
  disabled?: boolean;
}

export function DataTableSortList<TData extends RowData>({
  columns: allColumns,
  defaultSort,
  disabled,
  ...props
}: DataTableSortListProps<TData>) {
  const id = useId();
  const labelId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const sortCount = useDataTableStore((s) => s.sort.length);

  const [draftSorting, setDraftSorting] = useState<ColumnSort[]>([]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setDraftSorting(useDataTableStore.getState().sort);
    }
    setOpen(nextOpen);
  }, []);

  const onApply = useCallback(() => {
    useDataTableStore.getState().actions.setSorting(draftSorting);
    setOpen(false);
  }, [draftSorting]);

  const { columnLabels, columns } = useMemo(() => {
    const labels = new Map<string, string>();
    const sortingIds = new Set(draftSorting.map((s) => s.id));
    const availableColumns: { id: string; label: string }[] = [];

    for (const column of allColumns) {
      if (!column.getCanSort()) continue;

      const label = column.columnDef.meta?.label ?? column.id;
      labels.set(column.id, label);

      if (!sortingIds.has(column.id)) {
        availableColumns.push({ id: column.id, label });
      }
    }

    return {
      columnLabels: labels,
      columns: availableColumns,
    };
  }, [draftSorting, allColumns]);

  const onSortAdd = useCallback(() => {
    const firstColumn = columns[0];
    if (!firstColumn) return;

    setDraftSorting((prev) => [...prev, { id: firstColumn.id, desc: false }]);
  }, [columns]);

  const onSortUpdate = useCallback(
    (sortId: string, updates: Partial<ColumnSort>) => {
      setDraftSorting((prev) =>
        prev.map((s) => (s.id === sortId ? { ...s, ...updates } : s))
      );
    },
    []
  );

  const onSortRemove = useCallback((sortId: string) => {
    setDraftSorting((prev) => prev.filter((s) => s.id !== sortId));
  }, []);

  const onSortingReset = useCallback(
    () => setDraftSorting(defaultSort),
    [defaultSort]
  );

  const toggleOpen = useCallback(
    () => handleOpenChange(!open),
    [open, handleOpenChange]
  );
  usePopoverShortcut(SORT_SHORTCUT_KEY, toggleOpen);

  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!(
        REMOVE_ITEM_SHORTCUTS.has(event.key.toLowerCase()) && sortCount > 0
      )) {
        return;
      }

      event.preventDefault();
      onSortingReset();
    },
    [sortCount, onSortingReset]
  );

  return (
    <Sortable
      value={draftSorting}
      onValueChange={setDraftSorting}
      getItemValue={getSortItemValue}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            className='text-sm font-normal hover:shadow-md dark:bg-input/30 hover:dark:bg-input/45'
            onKeyDown={onTriggerKeyDown}
            disabled={disabled}
          >
            <Icon
              icon='solar:sort-vertical-linear'
              className='size-4 text-muted-foreground'
            />
            <span>ترتيب</span>
            {sortCount > 0 && (
              <Badge
                variant='secondary'
                className='h-4 rounded-xs px-1 font-mono text-xs font-normal'
              >
                {sortCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className='flex w-full max-w-[--radix-popover-content-available-width] flex-col gap-3.5 px-0 py-4 text-sm shadow-[0_5px_22px_-3px_rgba(0,0,0,0.12)] sm:min-w-80'
          {...props}
        >
          <h4
            id={labelId}
            className='border-b px-3 pb-3 text-base font-medium leading-none'
          >
            الترتيب
          </h4>
          <p
            id={descriptionId}
            className={cn(
              'my-5 px-3 text-center text-sm text-muted-foreground',
              draftSorting.length > 0 && 'sr-only'
            )}
          >
            {draftSorting.length > 0 ? MSG_EDIT_SORT : MSG_NO_SORT}
          </p>
          {draftSorting.length > 0 ? (
            <SortableContent asChild>
              <div
                role='list'
                className='my-2 flex max-h-80 flex-col gap-2 overflow-y-auto p-1 px-3'
              >
                {draftSorting.map((sort) => (
                  <DataTableSortItem
                    key={sort.id}
                    sort={sort}
                    sortItemId={`${id}-sort-${sort.id}`}
                    columns={columns}
                    columnLabels={columnLabels}
                    onSortUpdate={onSortUpdate}
                    onSortRemove={onSortRemove}
                  />
                ))}
              </div>
            </SortableContent>
          ) : null}
          <div className='flex w-full items-center justify-between gap-2 border-t px-3 pt-3'>
            {draftSorting.length > 0 ? (
              <Button
                variant='destructiveGhost'
                size='sm'
                className='rounded text-sm'
                onClick={onSortingReset}
              >
                إعادة تعيين
              </Button>
            ) : null}
            <div className='ms-auto flex items-center gap-2'>
              <Button
                variant='none'
                size='sm'
                className='rounded border border-dashed text-sm hover:bg-primary/10'
                ref={addButtonRef}
                onClick={onSortAdd}
                disabled={columns.length === 0}
              >
                <Icon icon='solar:add-linear' className='size-4' />
                <span>إضافة ترتيب</span>
              </Button>
              <Button size='sm' className='rounded text-sm' onClick={onApply}>
                تطبيق
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <SortableOverlay>
        <div className='flex items-center gap-2'>
          <div className='h-8 w-32 rounded-sm bg-primary/10' />
          <div className='h-8 w-24 rounded-sm bg-primary/10' />
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}

interface SortFieldItemProps {
  columnId: string;
  label: string;
  sortId: string;
  onSortUpdate: (sortId: string, updates: Partial<ColumnSort>) => void;
}

const SortFieldItem = memo(
  ({ columnId, label, sortId, onSortUpdate }: SortFieldItemProps) => {
    const onSelect = useCallback(
      () => onSortUpdate(sortId, { id: columnId }),
      [sortId, columnId, onSortUpdate]
    );

    return (
      <CommandItem value={columnId} onSelect={onSelect}>
        <span className='truncate'>{label}</span>
      </CommandItem>
    );
  }
);
SortFieldItem.displayName = 'SortFieldItem';

interface DataTableSortItemProps {
  sort: ColumnSort;
  sortItemId: string;
  columns: { id: string; label: string }[];
  columnLabels: Map<string, string>;
  onSortUpdate: (sortId: string, updates: Partial<ColumnSort>) => void;
  onSortRemove: (sortId: string) => void;
}

const DataTableSortItem = memo(
  ({
    sort,
    sortItemId,
    columns,
    columnLabels,
    onSortUpdate,
    onSortRemove,
  }: DataTableSortItemProps) => {
    const fieldListboxId = `${sortItemId}-field-listbox`;
    const fieldTriggerId = `${sortItemId}-field-trigger`;
    const directionListboxId = `${sortItemId}-direction-listbox`;

    const [showFieldSelector, setShowFieldSelector] = useState(false);
    const [showDirectionSelector, setShowDirectionSelector] = useState(false);

    const onDirectionChange = useCallback(
      (value: SortDirection) =>
        onSortUpdate(sort.id, { desc: value === 'desc' }),
      [sort.id, onSortUpdate]
    );

    const onRemove = useCallback(
      () => onSortRemove(sort.id),
      [sort.id, onSortRemove]
    );

    const onItemKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (
          showFieldSelector ||
          showDirectionSelector ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        ) {
          return;
        }

        if (REMOVE_ITEM_SHORTCUTS.has(event.key.toLowerCase())) {
          event.preventDefault();
          onSortRemove(sort.id);
        }
      },
      [sort.id, showFieldSelector, showDirectionSelector, onSortRemove]
    );

    return (
      <SortableItem value={sort.id} asChild>
        <div
          role='listitem'
          id={sortItemId}
          tabIndex={-1}
          className='flex items-center gap-2'
          onKeyDown={onItemKeyDown}
        >
          <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
            <PopoverTrigger asChild>
              <Button
                id={fieldTriggerId}
                aria-controls={fieldListboxId}
                variant='none'
                size='none'
                className='h-8 w-32 min-w-0 justify-between rounded-md border bg-transparent px-3 py-1 text-base font-normal shadow-sm hover:shadow-md dark:bg-input/30 hover:dark:bg-input/45 md:text-sm'
              >
                <span className='truncate'>{columnLabels.get(sort.id)}</span>
                <Icon
                  icon='lucide:chevrons-up-down'
                  className='size-4 opacity-40'
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              id={fieldListboxId}
              className='w-[--radix-popover-trigger-width] p-0'
            >
              <Command>
                <CommandInput placeholder={MSG_FIND_FIELD} />
                <CommandList>
                  <CommandEmpty>{MSG_NO_FIELDS}</CommandEmpty>
                  <CommandGroup>
                    {columns.map((column) => (
                      <SortFieldItem
                        key={column.id}
                        columnId={column.id}
                        label={column.label}
                        sortId={sort.id}
                        onSortUpdate={onSortUpdate}
                      />
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Select
            open={showDirectionSelector}
            onOpenChange={setShowDirectionSelector}
            value={sort.desc ? 'desc' : 'asc'}
            onValueChange={onDirectionChange}
          >
            <SelectTrigger
              aria-controls={directionListboxId}
              size='sm'
              className='!h-8 w-24 rounded shadow-sm'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              id={directionListboxId}
              className='min-w-[--radix-select-trigger-width]'
            >
              {dataTableConfig.sortOrders.map((order) => (
                <SelectItem key={order.value} value={order.value}>
                  {order.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            aria-controls={sortItemId}
            variant='destructiveGhost'
            size='icon'
            className='size-8 rounded text-muted-foreground hover:text-destructive'
            onClick={onRemove}
          >
            <Icon icon='solar:trash-bin-trash-linear' className='size-4' />
          </Button>
          <SortableItemHandle asChild>
            <Button
              variant='ghost'
              size='icon'
              className='size-8 rounded text-muted-foreground'
            >
              <Icon icon='solar:grip-vertical-linear' className='size-4' />
            </Button>
          </SortableItemHandle>
        </div>
      </SortableItem>
    );
  }
);
DataTableSortItem.displayName = 'DataTableSortItem';
