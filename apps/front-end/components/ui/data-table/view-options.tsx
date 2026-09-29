import type { DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import type { Column } from '@tanstack/react-table';

import { memo, useCallback, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';

import { NO_RESULTS_MESSAGE } from '@/utils/ui-messages';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Icon } from '@/components/ui/icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from '@/components/ui/sortable';

import { useColumnActions, useColumnStore } from './store/context';
import { genericMemo } from './utils/generic-memo';

interface ColumnEntry {
  id: string;
  label: string;
  canHide: boolean;
}

const DragHandle = memo(() => (
  <SortableItemHandle
    asChild
    className='flex shrink-0 items-center text-muted-foreground hover:text-foreground'
  >
    <div>
      <Icon icon='solar:grip-vertical-linear' className='size-4' />
    </div>
  </SortableItemHandle>
));

DragHandle.displayName = 'DragHandle';

const ColumnItem = memo(
  ({ column, showHandle }: { column: ColumnEntry; showHandle?: boolean }) => {
    const actions = useColumnActions();
    const isVisible = useColumnStore(
      (s) => s.columnVisibility[column.id] !== false
    );

    const handleSelect = useCallback(() => {
      if (column.canHide) actions.setVisible(column.id, !isVisible);
    }, [actions, column.id, column.canHide, isVisible]);

    return (
      <CommandItem
        onSelect={handleSelect}
        className={cn('w-full gap-2', !column.canHide && 'opacity-60')}
      >
        <div
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary',
            isVisible
              ? 'bg-primary text-primary-foreground'
              : 'opacity-50 [&_svg]:invisible'
          )}
        >
          <Icon
            icon='solar:check-read-linear'
            className='size-3.5 text-background'
          />
        </div>
        <span className='flex-1 truncate'>{column.label}</span>
        {showHandle && <DragHandle />}
      </CommandItem>
    );
  }
);

ColumnItem.displayName = 'ColumnItem';

const ShowAllItem = memo(() => {
  const actions = useColumnActions();
  const hasHidden = useColumnStore((s) =>
    Object.values(s.columnVisibility).includes(false)
  );
  if (!hasHidden) return null;
  return (
    <CommandGroup>
      <CommandItem
        onSelect={actions.showAll}
        className='justify-center text-center'
      >
        اظهار الكل
      </CommandItem>
    </CommandGroup>
  );
});

ShowAllItem.displayName = 'ShowAllItem';

interface ViewOptionsProps<TData> {
  columns: Column<TData>[];
}

const DataTableViewOptionsInner = <TData,>({
  columns,
}: ViewOptionsProps<TData>) => {
  const actions = useColumnActions();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const columnOrder = useColumnStore((s) => s.columnOrder);

  const entries = useMemo(
    () =>
      columns.map<ColumnEntry>((column) => ({
        id: column.id,
        label: column.columnDef.meta?.label ?? column.id,
        canHide: column.getCanHide(),
      })),
    [columns]
  );

  const orderedEntries = useMemo(() => {
    const rank = new Map(columnOrder.map((id, index) => [id, index]));
    return [...entries].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
    );
  }, [entries, columnOrder]);

  const term = search.trim().toLowerCase();
  const visibleEntries = useMemo(
    () =>
      term
        ? orderedEntries.filter((entry) =>
            entry.label.toLowerCase().includes(term)
          )
        : orderedEntries,
    [orderedEntries, term]
  );
  const entryIds = useMemo(
    () => visibleEntries.map((entry) => entry.id),
    [visibleEntries]
  );

  // `onMove` replaces the list's own reorder: the drop goes to the store,
  // which also moves the column in or out of a pin zone.
  const handleMove = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (over) actions.drop(String(active.id), String(over.id));
    },
    [actions]
  );

  // The dragged copy has no handle: a `SortableItemHandle` outside its item
  // throws, and the overlay is not inside one.
  const renderOverlay = useCallback(
    ({ value }: { value: UniqueIdentifier }) => {
      const entry = entries.find((e) => e.id === value);
      return entry ? <ColumnItem column={entry} /> : null;
    },
    [entries]
  );

  const handleReset = useCallback(() => {
    actions.reset();
    setOpen(false);
  }, [actions]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          className='border-dashed border-border px-3 py-1 text-sm font-medium max-lg:self-end'
        >
          <Icon icon='solar:tuning-2-linear' className='size-4 opacity-70' />
          <span className='py-0.5'>العرض</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-56 p-0' align='end'>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder='بحث عن عمود...'
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{NO_RESULTS_MESSAGE}</CommandEmpty>
            <CommandGroup>
              {term ? (
                visibleEntries.map((entry) => (
                  <ColumnItem key={entry.id} column={entry} />
                ))
              ) : (
                <Sortable value={entryIds} onMove={handleMove}>
                  <SortableContent withoutSlot>
                    {visibleEntries.map((entry) => (
                      <SortableItem
                        key={entry.id}
                        value={entry.id}
                        className='flex items-center'
                      >
                        <ColumnItem column={entry} showHandle />
                      </SortableItem>
                    ))}
                  </SortableContent>
                  <SortableOverlay>{renderOverlay}</SortableOverlay>
                </Sortable>
              )}
            </CommandGroup>
            <CommandSeparator />
            <ShowAllItem />
            <CommandGroup>
              <CommandItem
                onSelect={handleReset}
                className='justify-center text-center'
              >
                إعادة ضبط الاعمدة
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

const DataTableViewOptions = genericMemo(
  DataTableViewOptionsInner,
  'DataTableViewOptions'
);

export { DataTableViewOptions };
