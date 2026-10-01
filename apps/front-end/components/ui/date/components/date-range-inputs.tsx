import type { DateRange, DateRangeUpdate } from '../types';

import { memo, useCallback } from 'react';

import { DateInput } from '../date-input';

interface DateRangeInputsProps {
  range: DateRange;
  onRangeChange: (update: DateRangeUpdate) => void;
}

// Editing one bound never invents the other — an open-ended range is a valid
// filter — so clamping applies only when both bounds exist.
export const DateRangeInputs = memo(
  ({ range, onRangeChange }: DateRangeInputsProps) => {
    const handleFromChange = useCallback(
      (date: Date | undefined) =>
        onRangeChange((prev) => ({
          from: date,
          to:
            date && prev.to
              ? new Date(Math.max(date.getTime(), prev.to.getTime()))
              : prev.to,
        })),
      [onRangeChange]
    );

    const handleToChange = useCallback(
      (date: Date | undefined) =>
        onRangeChange((prev) => ({
          from:
            date && prev.from
              ? new Date(Math.min(date.getTime(), prev.from.getTime()))
              : prev.from,
          to: date && new Date(date),
        })),
      [onRangeChange]
    );

    return (
      <div className='flex justify-around gap-2'>
        <DateInput value={range.from} onChange={handleFromChange} />
        <DateInput value={range.to} onChange={handleToChange} />
      </div>
    );
  }
);

DateRangeInputs.displayName = 'DateRangeInputs';
