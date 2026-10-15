import type { FilterItemSchema } from '@app/shared/data-table/parsers';
import type {
  FilterOperator,
  FilterVariant,
  JoinOperator,
} from '@app/shared/types/data-table';
import type { Column } from '@tanstack/react-table';
import type { ComponentProps, KeyboardEvent } from 'react';

import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';

import { dataTableConfig } from '@app/shared/data-table/config';
import {
  MSG_EDIT_FILTERS,
  MSG_FIND_FIELD,
  MSG_NO_FIELDS,
  MSG_NO_FILTERS,
} from '@/constants/messages';
import { cn } from '@/lib/utils';

import { generateId } from '@/utils/generate-id';

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
import {
  getDefaultFilterOperator,
  getFilterOperators,
} from '../utils/data-table';
import { genericMemo } from '../utils/generic-memo';
import { FilterInput } from './filter-inputs';

const FILTER_SHORTCUT_KEY = 'f';

const joinOperatorLabels: Record<JoinOperator, string> = {
  and: 'و',
  or: 'أو',
};

const getFilterItemValue = (item: FilterItemSchema) => item.filterId;

interface DataTableFilterListProps<TData> extends ComponentProps<
  typeof PopoverContent
> {
  columns: Column<TData>[];
  disabled?: boolean;
}

export function DataTableFilterList<TData>({
  columns: allColumns,
  disabled,
  ...props
}: DataTableFilterListProps<TData>) {
  const id = useId();
  const labelId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const columns = useMemo(
    () => allColumns.filter((column) => column.columnDef.enableColumnFilter),
    [allColumns]
  );

  const filterCount = useDataTableStore((s) => s.filters.length);

  const [draftFilters, setDraftFilters] = useState<FilterItemSchema[]>([]);
  const [draftJoinOperator, setDraftJoinOperator] =
    useState<JoinOperator>('and');

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      const state = useDataTableStore.getState();
      setDraftFilters(state.filters);
      setDraftJoinOperator(state.joinOperator);
    }
    setOpen(nextOpen);
  }, []);

  const onApply = useCallback(() => {
    useDataTableStore
      .getState()
      .actions.applyFilters(draftFilters, draftJoinOperator);
    setOpen(false);
  }, [draftFilters, draftJoinOperator]);

  const onFilterAdd = useCallback(() => {
    const column = columns[0];

    if (!column) return;

    setDraftFilters((prev) => [
      ...prev,
      {
        id: column.id,
        value: '',
        variant: column.columnDef.meta?.variant ?? 'text',
        operator: getDefaultFilterOperator(
          column.columnDef.meta?.variant ?? 'text'
        ),
        filterId: generateId({ length: 8 }),
      },
    ]);
  }, [columns]);

  const onFilterUpdate = useCallback(
    (
      filterId: string,
      updates: Partial<Omit<FilterItemSchema, 'filterId'>>
    ) => {
      setDraftFilters((prev) =>
        prev.map((filter) =>
          filter.filterId === filterId ? { ...filter, ...updates } : filter
        )
      );
    },
    []
  );

  const onFilterRemove = useCallback((filterId: string) => {
    setDraftFilters((prev) =>
      prev.filter((filter) => filter.filterId !== filterId)
    );
    requestAnimationFrame(() => {
      addButtonRef.current?.focus();
    });
  }, []);

  const onFiltersReset = useCallback(() => {
    setDraftFilters([]);
    setDraftJoinOperator('and');
  }, []);

  const toggleOpen = useCallback(
    () => handleOpenChange(!open),
    [open, handleOpenChange]
  );
  usePopoverShortcut(FILTER_SHORTCUT_KEY, toggleOpen);

  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!(
        REMOVE_ITEM_SHORTCUTS.has(event.key.toLowerCase()) &&
        draftFilters.length > 0
      )) {
        return;
      }

      event.preventDefault();
      onFilterRemove(draftFilters[draftFilters.length - 1]?.filterId ?? '');
    },
    [draftFilters, onFilterRemove]
  );

  return (
    <Sortable
      value={draftFilters}
      onValueChange={setDraftFilters}
      getItemValue={getFilterItemValue}
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
              icon='solar:filter-linear'
              className='size-4 text-muted-foreground'
            />
            <span>تصفية</span>
            {filterCount > 0 && (
              <Badge
                variant='secondary'
                className='h-4 rounded-xs px-1 font-mono text-xs font-normal'
              >
                {filterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-describedby={descriptionId}
          aria-labelledby={labelId}
          className='flex w-full max-w-[--radix-popover-content-available-width] flex-col gap-3.5 px-0 py-4 text-sm shadow-[0_5px_22px_-3px_rgba(0,0,0,0.12)] sm:min-w-96'
          {...props}
        >
          <h4
            id={labelId}
            className='border-b px-3 pb-3 text-base font-medium leading-none'
          >
            التصفيات
          </h4>
          <p
            id={descriptionId}
            className={cn(
              'my-5 px-3 text-center text-sm text-muted-foreground',
              draftFilters.length > 0 && 'sr-only'
            )}
          >
            {draftFilters.length > 0 ? MSG_EDIT_FILTERS : MSG_NO_FILTERS}
          </p>
          {draftFilters.length > 0 ? (
            <SortableContent asChild>
              <div
                role='list'
                className='my-2 flex max-h-80 flex-col gap-2 overflow-y-auto p-1 px-3'
              >
                {draftFilters.map((filter, index) => (
                  <DataTableFilterItem<TData>
                    key={filter.filterId}
                    filter={filter}
                    index={index}
                    filterItemId={`${id}-filter-${filter.filterId}`}
                    joinOperator={draftJoinOperator}
                    setJoinOperator={setDraftJoinOperator}
                    columns={columns}
                    onFilterUpdate={onFilterUpdate}
                    onFilterRemove={onFilterRemove}
                  />
                ))}
              </div>
            </SortableContent>
          ) : null}
          <div className='flex w-full items-center justify-between gap-2 border-t px-3 pt-3'>
            {draftFilters.length > 0 ? (
              <Button
                variant='destructiveGhost'
                size='sm'
                className='rounded text-sm'
                onClick={onFiltersReset}
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
                onClick={onFilterAdd}
              >
                <Icon icon='solar:add-linear' className='size-4' />
                <span>إضافة تصفية</span>
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
          <div className='h-8 min-w-20 rounded-sm bg-primary/10' />
          <div className='flex flex-1 flex-col gap-2 md:flex-row md:items-center'>
            <div className='h-8 rounded-sm bg-primary/10 md:w-32' />
            <div className='h-8 rounded-sm bg-primary/10 md:w-32' />
            <div className='h-8 w-full min-w-36 flex-1 rounded-sm bg-primary/10' />
          </div>
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}

interface FilterFieldItemProps {
  columnId: string;
  label: string;
  variant: FilterVariant;
  isSelected: boolean;
  filterId: string;
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<FilterItemSchema, 'filterId'>>
  ) => void;
  onSelected: () => void;
}

const FilterFieldItem = memo(
  ({
    columnId,
    label,
    variant,
    isSelected,
    filterId,
    onFilterUpdate,
    onSelected,
  }: FilterFieldItemProps) => {
    const onSelect = useCallback(() => {
      onFilterUpdate(filterId, {
        id: columnId,
        variant,
        operator: getDefaultFilterOperator(variant),
        value: '',
      });
      onSelected();
    }, [columnId, variant, filterId, onFilterUpdate, onSelected]);

    return (
      <CommandItem
        value={columnId}
        onSelect={onSelect}
        className='justify-between'
      >
        <span className='truncate'>{label}</span>
        <Icon
          icon='solar:check-read-linear'
          className={cn(isSelected ? 'opacity-100' : 'opacity-0')}
        />
      </CommandItem>
    );
  }
);
FilterFieldItem.displayName = 'FilterFieldItem';

interface DataTableFilterItemProps<TData> {
  filter: FilterItemSchema;
  index: number;
  filterItemId: string;
  joinOperator: JoinOperator;
  setJoinOperator: (value: JoinOperator) => void;
  columns: Column<TData>[];
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<FilterItemSchema, 'filterId'>>
  ) => void;
  onFilterRemove: (filterId: string) => void;
}

function DataTableFilterItemInner<TData>({
  filter,
  index,
  filterItemId,
  joinOperator,
  setJoinOperator,
  columns,
  onFilterUpdate,
  onFilterRemove,
}: DataTableFilterItemProps<TData>) {
  const [showFieldSelector, setShowFieldSelector] = useState(false);
  const [showOperatorSelector, setShowOperatorSelector] = useState(false);
  const [showValueSelector, setShowValueSelector] = useState(false);

  const column = columns.find((column) => column.id === filter.id);

  const joinOperatorListboxId = `${filterItemId}-join-operator-listbox`;
  const fieldListboxId = `${filterItemId}-field-listbox`;
  const operatorListboxId = `${filterItemId}-operator-listbox`;
  const inputId = `${filterItemId}-input`;

  const columnMeta = column?.columnDef.meta;
  const filterOperators = getFilterOperators(filter.variant);

  const onOperatorChange = useCallback(
    (value: FilterOperator) =>
      onFilterUpdate(filter.filterId, {
        operator: value,
        value:
          value === 'isEmpty' || value === 'isNotEmpty' ? '' : filter.value,
      }),
    [filter.filterId, filter.value, onFilterUpdate]
  );

  const onCloseFieldSelector = useCallback(
    () => setShowFieldSelector(false),
    []
  );

  const onRemove = useCallback(
    () => onFilterRemove(filter.filterId),
    [filter.filterId, onFilterRemove]
  );

  const onItemKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        showFieldSelector ||
        showOperatorSelector ||
        showValueSelector ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (REMOVE_ITEM_SHORTCUTS.has(event.key.toLowerCase())) {
        event.preventDefault();
        onFilterRemove(filter.filterId);
      }
    },
    [
      filter.filterId,
      showFieldSelector,
      showOperatorSelector,
      showValueSelector,
      onFilterRemove,
    ]
  );

  if (!column) return null;

  return (
    <SortableItem value={filter.filterId} asChild>
      <div
        role='listitem'
        id={filterItemId}
        tabIndex={-1}
        className='flex items-center gap-2'
        onKeyDown={onItemKeyDown}
      >
        <div className='min-w-20'>
          {index === 0 ? (
            <span className='ps-3 text-sm text-muted-foreground'>حيث</span>
          ) : index === 1 ? (
            <Select value={joinOperator} onValueChange={setJoinOperator}>
              <SelectTrigger
                aria-label='طريقة الجمع بين التصفيات'
                aria-controls={joinOperatorListboxId}
                size='sm'
                className='!h-8 w-full rounded lowercase'
              >
                <SelectValue placeholder={joinOperatorLabels[joinOperator]} />
              </SelectTrigger>
              <SelectContent
                id={joinOperatorListboxId}
                position='popper'
                className='min-w-[--radix-select-trigger-width] lowercase'
              >
                {dataTableConfig.joinOperators.map((joinOperator) => (
                  <SelectItem key={joinOperator} value={joinOperator}>
                    {joinOperatorLabels[joinOperator]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className='ps-3 text-sm text-muted-foreground'>
              {joinOperatorLabels[joinOperator]}
            </span>
          )}
        </div>
        <div className='flex flex-1 flex-col gap-2 md:flex-row md:items-center'>
          <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
            <PopoverTrigger asChild>
              <Button
                aria-controls={fieldListboxId}
                variant='none'
                size='none'
                className='h-8 min-w-0 justify-between rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45 md:w-32'
              >
                <span className='truncate'>
                  {columnMeta?.label ?? 'اختر حقل'}
                </span>
                <Icon
                  icon='solar:alt-arrow-down-linear'
                  className='size-4 text-muted-foreground opacity-80'
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              id={fieldListboxId}
              align='start'
              className='w-40 p-0'
            >
              <Command>
                <CommandInput placeholder={MSG_FIND_FIELD} />
                <CommandList>
                  <CommandEmpty>{MSG_NO_FIELDS}</CommandEmpty>
                  <CommandGroup>
                    {columns.map((option) => (
                      <FilterFieldItem
                        key={option.id}
                        columnId={option.id}
                        label={option.columnDef.meta?.label ?? option.id}
                        variant={option.columnDef.meta?.variant ?? 'text'}
                        isSelected={option.id === filter.id}
                        filterId={filter.filterId}
                        onFilterUpdate={onFilterUpdate}
                        onSelected={onCloseFieldSelector}
                      />
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Select
            open={showOperatorSelector}
            onOpenChange={setShowOperatorSelector}
            value={filter.operator}
            onValueChange={onOperatorChange}
          >
            <SelectTrigger
              aria-controls={operatorListboxId}
              size='sm'
              className='!h-8 w-full rounded bg-transparent lowercase shadow-xs hover:shadow-sm md:w-32'
            >
              <div className='truncate'>
                <SelectValue placeholder={filter.operator} />
              </div>
            </SelectTrigger>
            <SelectContent id={operatorListboxId}>
              {filterOperators.map((operator) => (
                <SelectItem
                  key={operator.value}
                  value={operator.value}
                  className='lowercase'
                >
                  {operator.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className='min-w-36 max-w-60 flex-1'>
            <FilterInput
              filter={filter}
              inputId={inputId}
              column={column}
              columnMeta={columnMeta}
              onFilterUpdate={onFilterUpdate}
              showValueSelector={showValueSelector}
              setShowValueSelector={setShowValueSelector}
            />
          </div>
        </div>

        <Button
          aria-controls={filterItemId}
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

const DataTableFilterItem = genericMemo(
  DataTableFilterItemInner,
  'DataTableFilterItem'
);
