import type { DataTableFeatures } from '../features';
import type { FilterItemSchema } from '@app/shared/data-table/parsers';
import type {
  FilterOperator,
  FilterVariant,
} from '@app/shared/types/data-table';
import type { Column, RowData } from '@tanstack/react-table';

import { useCallback, useId, useState } from 'react';

import { cn } from '@/lib/utils';

import { generateId } from '@/utils/generate-id';

import { useDataTableStore } from '@/components/ui/data-table/store/url-store';
import { Icon } from '@/components/ui/icon';

import { Button } from '../../button';
import { Popover, PopoverContent, PopoverTrigger } from '../../popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../select';
import { LabelTooltip } from '../../tooltip';
import {
  getDefaultFilterOperator,
  getFilterOperators,
  isValuelessOperator,
} from '../utils/data-table';
import { stopDragStart } from '../utils/events';
import { genericMemo } from '../utils/generic-memo';
import { FilterInput } from './filter-inputs';
import { filterField } from './segments';

interface ColumnFilterPopoverProps<TData extends RowData> {
  column: Column<DataTableFeatures, TData>;
}

function ColumnFilterPopoverInner<TData extends RowData>({
  column,
}: ColumnFilterPopoverProps<TData>) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [showValueSelector, setShowValueSelector] = useState(false);

  const columnId = column.id;
  const variant: FilterVariant = column.columnDef.meta?.variant ?? 'text';
  const filterOperators = getFilterOperators(variant);

  const [draftOperator, setDraftOperator] = useState<FilterOperator>(
    getDefaultFilterOperator(variant)
  );
  const [draftValue, setDraftValue] = useState<string | string[]>('');
  const [draftFilterId, setDraftFilterId] = useState('');

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        const { filters } = useDataTableStore.getState();
        const existing = filters.find((f) => f.id === columnId);
        if (existing) {
          setDraftOperator(existing.operator);
          setDraftValue(existing.value);
          setDraftFilterId(existing.filterId);
        } else {
          setDraftOperator(getDefaultFilterOperator(variant));
          setDraftValue('');
          setDraftFilterId('');
        }
      }
      setOpen(nextOpen);
    },
    [columnId, variant]
  );

  const onDraftUpdate = useCallback(
    (
      _filterId: string,
      updates: Partial<Omit<FilterItemSchema, 'filterId'>>
    ) => {
      if (updates.operator !== undefined) {
        setDraftOperator(updates.operator);
      }
      if (updates.value !== undefined) {
        setDraftValue(updates.value);
      }
    },
    []
  );

  const onOperatorChange = useCallback((value: FilterOperator) => {
    setDraftOperator(value);
    if (isValuelessOperator(value)) {
      setDraftValue('');
    }
  }, []);

  const onApply = useCallback(() => {
    const { setFilters } = useDataTableStore.getState().actions;
    const filters = [...useDataTableStore.getState().filters];

    const existingIndex = filters.findIndex((f) => f.id === columnId);

    const newFilter: FilterItemSchema = {
      id: columnId,
      value: draftValue,
      variant,
      operator: draftOperator,
      filterId: draftFilterId || generateId({ length: 8 }),
    };

    if (existingIndex === -1) {
      filters.push(newFilter);
    } else {
      filters[existingIndex] = newFilter;
    }

    setFilters(filters);
    setOpen(false);
  }, [columnId, variant, draftOperator, draftValue, draftFilterId]);

  const onReset = useCallback(() => {
    const { setFilters } = useDataTableStore.getState().actions;
    const filters = useDataTableStore
      .getState()
      .filters.filter((f) => f.id !== columnId);

    setFilters(filters);
    setDraftOperator(getDefaultFilterOperator(variant));
    setDraftValue('');
    setDraftFilterId('');
    setOpen(false);
  }, [columnId, variant]);

  const draftFilter: FilterItemSchema = {
    id: columnId,
    value: draftValue,
    variant,
    operator: draftOperator,
    filterId: draftFilterId || 'draft',
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <LabelTooltip label='بحث/تصفية'>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='ghost'
            className='h-7 w-7 shrink-0 rounded bg-accent p-1 text-accent-foreground opacity-0 transition-opacity duration-200 hover:!opacity-100 group-hover/header:opacity-80 touch:opacity-80'
            data-column-filter
            onPointerDown={stopDragStart}
          >
            <Icon icon='solar:filter-linear' className='size-4' />
          </Button>
        </PopoverTrigger>
      </LabelTooltip>
      <PopoverContent
        align='start'
        className='flex w-64 flex-col gap-3 p-3'
        onPointerDown={stopDragStart}
      >
        <Select value={draftOperator} onValueChange={onOperatorChange}>
          <SelectTrigger size='sm' className={cn(filterField, 'lowercase')}>
            <div className='truncate'>
              <SelectValue placeholder={draftOperator} />
            </div>
          </SelectTrigger>
          <SelectContent>
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

        <FilterInput
          filter={draftFilter}
          inputId={inputId}
          column={column}
          columnMeta={column.columnDef.meta}
          onFilterUpdate={onDraftUpdate}
          showValueSelector={showValueSelector}
          setShowValueSelector={setShowValueSelector}
        />

        <div className='flex items-center justify-between gap-2 border-t pt-3'>
          <Button
            variant='outline'
            size='sm'
            className='rounded text-sm'
            onClick={onReset}
          >
            إعادة تعيين
          </Button>
          <Button size='sm' className='rounded text-sm' onClick={onApply}>
            تطبيق
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const ColumnFilterPopover = genericMemo(
  ColumnFilterPopoverInner,
  'ColumnFilterPopover'
);

export { ColumnFilterPopover };
