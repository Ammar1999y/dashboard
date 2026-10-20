import type { DataTableFeatures } from '../features';
import type { FilterItemSchema } from '@app/shared/data-table/parsers';
import type { Column, RowData } from '@tanstack/react-table';
import type { ChangeEvent, ComponentProps } from 'react';

import { useCallback, useMemo } from 'react';

import { cn } from '@/lib/utils';

import { Input } from '@/components/ui/input';

import { genericMemo } from '../utils/generic-memo';
import {
  filterField,
  filterSegmentFirst,
  filterSegmentLast,
  filterSegmentWrapper,
} from './segments';

// For a column without `meta.range`; no table registers TanStack's faceting.
const DEFAULT_RANGE: [number, number] = [0, 100];

interface DataTableRangeFilterProps<
  TData extends RowData,
> extends ComponentProps<'div'> {
  filter: FilterItemSchema;
  column: Column<DataTableFeatures, TData>;
  inputId: string;
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<FilterItemSchema, 'filterId'>>
  ) => void;
}

function DataTableRangeFilterInner<TData extends RowData>({
  filter,
  column,
  inputId,
  onFilterUpdate,
  className,
  ...props
}: DataTableRangeFilterProps<TData>) {
  const meta = column.columnDef.meta;

  const [min, max] = column.columnDef.meta?.range ?? DEFAULT_RANGE;

  const formatValue = useCallback((value: string | number | undefined) => {
    if (value === undefined || value === '') return '';
    const numValue = Number(value);
    return Number.isNaN(numValue)
      ? ''
      : numValue.toLocaleString(undefined, {
          maximumFractionDigits: 0,
        });
  }, []);

  const value = useMemo(() => {
    if (Array.isArray(filter.value)) return filter.value.map(formatValue);
    return [formatValue(filter.value), ''];
  }, [filter.value, formatValue]);

  const onRangeValueChange = useCallback(
    (value: string, isMin?: boolean) => {
      const numValue = Number(value);
      const currentValues = Array.isArray(filter.value)
        ? filter.value
        : ['', ''];
      const otherValue = isMin
        ? (currentValues[1] ?? '')
        : (currentValues[0] ?? '');

      if (
        value === '' ||
        (!Number.isNaN(numValue) &&
          (isMin
            ? numValue >= min && numValue <= (Number(otherValue) || max)
            : numValue <= max && numValue >= (Number(otherValue) || min)))
      ) {
        onFilterUpdate(filter.filterId, {
          value: isMin ? [value, otherValue] : [otherValue, value],
        });
      }
    },
    [filter.filterId, filter.value, min, max, onFilterUpdate]
  );

  const onMinChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onRangeValueChange(event.target.value, true),
    [onRangeValueChange]
  );

  const onMaxChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onRangeValueChange(event.target.value),
    [onRangeValueChange]
  );

  return (
    <div
      data-slot='range'
      className={cn(
        'flex w-full items-center gap-2 group-data-[segmented]/segments:gap-0',
        filterSegmentWrapper,
        className
      )}
      {...props}
    >
      <Input
        id={`${inputId}-min`}
        type='number'
        aria-label={`${meta?.label} minimum value`}
        aria-valuemin={min}
        aria-valuemax={max}
        data-slot='range-min'
        inputMode='numeric'
        placeholder={min.toString()}
        min={min}
        max={max}
        className={cn(filterField, filterSegmentFirst)}
        defaultValue={value[0]}
        onChange={onMinChange}
      />
      <span className='sr-only shrink-0 text-muted-foreground'>إلى</span>
      <Input
        id={`${inputId}-max`}
        type='number'
        aria-label={`${meta?.label} maximum value`}
        aria-valuemin={min}
        aria-valuemax={max}
        data-slot='range-max'
        inputMode='numeric'
        placeholder={max.toString()}
        min={min}
        max={max}
        className={cn(filterField, filterSegmentLast)}
        defaultValue={value[1]}
        onChange={onMaxChange}
      />
    </div>
  );
}

const DataTableRangeFilter = genericMemo(
  DataTableRangeFilterInner,
  'DataTableRangeFilter'
);

export { DataTableRangeFilter };
