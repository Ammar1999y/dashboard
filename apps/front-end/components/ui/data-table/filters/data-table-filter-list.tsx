import type { DataTableFeatures } from '../features';
import type { FilterItemSchema } from '@app/shared/data-table/parsers';
import type {
  FilterOperator,
  FilterVariant,
  JoinOperator,
} from '@app/shared/types/data-table';
import type { Column, RowData } from '@tanstack/react-table';
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
  isValuelessOperator,
} from '../utils/data-table';
import { genericMemo } from '../utils/generic-memo';
import { FilterInput } from './filter-inputs';
import { filterField, filterSegments, filterTrigger } from './segments';

const FILTER_SHORTCUT_KEY = 'f';
// Half the 32px the phone width leaves out, so the popover sits centred.
const POPOVER_GUTTER = 16;
const WHERE_LABEL = 'حيث';

// Each slot rounds the corners of the segment group it sits on, so its control
// (which inherits the radius) curves with the group. Phones stack the field
// over operator + value; from `md` the three share one line.
const FIELD_SLOT_RADIUS =
  'rounded-t md:ltr:rounded-bl md:ltr:rounded-tr-none md:rtl:rounded-br md:rtl:rounded-tl-none';
const OPERATOR_SLOT_RADIUS =
  'ltr:rounded-bl rtl:rounded-br md:ltr:rounded-bl-none md:rtl:rounded-br-none';
const LAST_OPERATOR_SLOT_RADIUS =
  'rounded-b md:ltr:rounded-bl-none md:ltr:rounded-tr md:rtl:rounded-br-none md:rtl:rounded-tl';
const VALUE_SLOT_RADIUS =
  'ltr:rounded-br rtl:rounded-bl md:ltr:rounded-tr md:rtl:rounded-tl';

const joinOperatorLabels: Record<JoinOperator, string> = {
  and: 'و',
  or: 'أو',
};

const getFilterItemValue = (item: FilterItemSchema) => item.filterId;

interface JoinOperatorToggleProps {
  joinOperator: JoinOperator;
  onToggle: () => void;
}

const JoinOperatorToggle = memo(
  ({ joinOperator, onToggle }: JoinOperatorToggleProps) => (
    <Button
      aria-label={`طريقة الجمع بين التصفيات: ${joinOperatorLabels[joinOperator]}`}
      variant='outline'
      size='none'
      className='relative h-7 gap-1 rounded-md bg-popover px-2 text-sm font-normal'
      onClick={onToggle}
    >
      {joinOperatorLabels[joinOperator]}
      <Icon
        icon='solar:refresh-linear'
        className='size-3.5 text-muted-foreground'
      />
    </Button>
  )
);
JoinOperatorToggle.displayName = 'JoinOperatorToggle';

interface JoinOperatorOptionProps {
  value: JoinOperator;
  isActive: boolean;
  onSelect: (value: JoinOperator) => void;
}

const JoinOperatorOption = memo(
  ({ value, isActive, onSelect }: JoinOperatorOptionProps) => {
    const onClick = useCallback(() => onSelect(value), [value, onSelect]);

    return (
      <button
        type='button'
        aria-pressed={isActive}
        className={cn(
          'flex-1 rounded-md text-sm font-medium text-muted-foreground transition-[color,background-color,box-shadow] hover:text-foreground',
          isActive && 'bg-background text-foreground shadow-sm'
        )}
        onClick={onClick}
      >
        {joinOperatorLabels[value]}
      </button>
    );
  }
);
JoinOperatorOption.displayName = 'JoinOperatorOption';

interface JoinOperatorSwitchProps {
  joinOperator: JoinOperator;
  onSelect: (value: JoinOperator) => void;
}

const JoinOperatorSwitch = memo(
  ({ joinOperator, onSelect }: JoinOperatorSwitchProps) => (
    <div
      role='group'
      aria-label='طريقة الجمع بين التصفيات'
      className='flex h-9 flex-1 gap-1 rounded-lg bg-muted p-1'
    >
      {dataTableConfig.joinOperators.map((value) => (
        <JoinOperatorOption
          key={value}
          value={value}
          isActive={value === joinOperator}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
);
JoinOperatorSwitch.displayName = 'JoinOperatorSwitch';

interface DataTableFilterListProps<
  TData extends RowData,
> extends ComponentProps<typeof PopoverContent> {
  columns: Column<DataTableFeatures, TData>[];
  disabled?: boolean;
}

export function DataTableFilterList<TData extends RowData>({
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

  const onJoinOperatorToggle = useCallback(() => {
    setDraftJoinOperator((prev) => (prev === 'and' ? 'or' : 'and'));
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
          collisionPadding={POPOVER_GUTTER}
          className='flex w-[calc(100vw-32px)] flex-col gap-3.5 px-0 py-4 text-sm shadow-[0_5px_22px_-3px_rgba(0,0,0,0.12)] md:w-full md:min-w-96 md:max-w-[--radix-popover-content-available-width]'
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
            <>
              <div className='flex items-center gap-2 px-3 md:hidden'>
                <span className='text-sm text-muted-foreground'>
                  {WHERE_LABEL}
                </span>
                {draftFilters.length > 1 ? (
                  <JoinOperatorSwitch
                    joinOperator={draftJoinOperator}
                    onSelect={setDraftJoinOperator}
                  />
                ) : null}
              </div>
              <div className='my-2 max-h-80 overflow-y-auto p-1 px-3'>
                <div className='flex gap-2'>
                  <div className='hidden w-12 shrink-0 flex-col gap-2 md:flex'>
                    <span className='flex h-8 items-center text-sm text-muted-foreground'>
                      {WHERE_LABEL}
                    </span>
                    {draftFilters.length > 1 ? (
                      <div className='relative flex flex-1 items-center justify-center'>
                        {draftFilters.length > 2 ? (
                          <span className='absolute inset-y-2 border-y border-s ltr:left-1/2 ltr:right-0 ltr:rounded-l-md rtl:left-0 rtl:right-1/2 rtl:rounded-r-md' />
                        ) : null}
                        <JoinOperatorToggle
                          joinOperator={draftJoinOperator}
                          onToggle={onJoinOperatorToggle}
                        />
                      </div>
                    ) : null}
                  </div>
                  <SortableContent asChild>
                    <div
                      role='list'
                      className='flex min-w-0 flex-1 flex-col gap-3 md:gap-2'
                    >
                      {draftFilters.map((filter) => (
                        <DataTableFilterItem<TData>
                          key={filter.filterId}
                          filter={filter}
                          filterItemId={`${id}-filter-${filter.filterId}`}
                          columns={columns}
                          onFilterUpdate={onFilterUpdate}
                          onFilterRemove={onFilterRemove}
                        />
                      ))}
                    </div>
                  </SortableContent>
                </div>
              </div>
            </>
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
          <div className='h-16 flex-1 rounded bg-primary/10 md:h-8' />
          <div className='flex flex-col md:flex-row md:gap-2'>
            <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
            <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
          </div>
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

interface DataTableFilterItemProps<TData extends RowData> {
  filter: FilterItemSchema;
  filterItemId: string;
  columns: Column<DataTableFeatures, TData>[];
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<FilterItemSchema, 'filterId'>>
  ) => void;
  onFilterRemove: (filterId: string) => void;
}

function DataTableFilterItemInner<TData extends RowData>({
  filter,
  filterItemId,
  columns,
  onFilterUpdate,
  onFilterRemove,
}: DataTableFilterItemProps<TData>) {
  const [showFieldSelector, setShowFieldSelector] = useState(false);
  const [showOperatorSelector, setShowOperatorSelector] = useState(false);
  const [showValueSelector, setShowValueSelector] = useState(false);

  const column = columns.find((column) => column.id === filter.id);

  const fieldListboxId = `${filterItemId}-field-listbox`;
  const operatorListboxId = `${filterItemId}-operator-listbox`;
  const inputId = `${filterItemId}-input`;

  const columnMeta = column?.columnDef.meta;
  const filterOperators = getFilterOperators(filter.variant);

  const onOperatorChange = useCallback(
    (value: FilterOperator) =>
      onFilterUpdate(filter.filterId, {
        operator: value,
        value: isValuelessOperator(value) ? '' : filter.value,
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

  const hasValue = !isValuelessOperator(filter.operator);

  return (
    <SortableItem value={filter.filterId} asChild>
      <div
        role='listitem'
        id={filterItemId}
        tabIndex={-1}
        className='flex items-center gap-2'
        onKeyDown={onItemKeyDown}
      >
        <div
          data-segmented=''
          className={cn(
            filterSegments,
            'grid min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:flex'
          )}
        >
          <div
            className={cn(
              'col-span-2 border-b md:w-32 md:shrink-0 md:border-b-0 md:border-e',
              FIELD_SLOT_RADIUS
            )}
          >
            <Popover
              open={showFieldSelector}
              onOpenChange={setShowFieldSelector}
            >
              <PopoverTrigger asChild>
                <Button
                  aria-controls={fieldListboxId}
                  variant='none'
                  size='none'
                  className={cn(filterTrigger, 'w-full justify-between')}
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
          </div>
          <div
            className={
              hasValue
                ? cn('border-e md:w-32 md:shrink-0', OPERATOR_SLOT_RADIUS)
                : cn('col-span-2 md:flex-1', LAST_OPERATOR_SLOT_RADIUS)
            }
          >
            <Select
              open={showOperatorSelector}
              onOpenChange={setShowOperatorSelector}
              value={filter.operator}
              onValueChange={onOperatorChange}
            >
              <SelectTrigger
                aria-controls={operatorListboxId}
                size='sm'
                className={cn(filterField, 'lowercase')}
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
          </div>
          {/* Kept mounted without a value: the empty-state input announces the operator. */}
          <div
            className={
              hasValue
                ? cn('min-w-0 md:min-w-40 md:flex-1', VALUE_SLOT_RADIUS)
                : 'sr-only'
            }
          >
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
        <div className='flex flex-col md:flex-row md:gap-2'>
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
      </div>
    </SortableItem>
  );
}

const DataTableFilterItem = genericMemo(
  DataTableFilterItemInner,
  'DataTableFilterItem'
);
