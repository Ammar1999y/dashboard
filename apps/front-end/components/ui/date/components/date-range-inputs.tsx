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
      (date: Date | undefined) => {
        if (!date) {
          onRangeChange((prev) => ({ ...prev, from: undefined }));
          return;
        }
        onRangeChange((prev) => ({
          ...prev,
          from: date,
          ...(range.to && {
            to: new Date(Math.max(date.getTime(), range.to.getTime())),
          }),
        }));
      },
      [range.to, onRangeChange]
    );

    const handleToChange = useCallback(
      (date: Date | undefined) => {
        if (!date) {
          onRangeChange((prev) => ({ ...prev, to: undefined }));
          return;
        }
        onRangeChange((prev) => ({
          ...prev,
          ...(range.from && {
            from: new Date(Math.min(date.getTime(), range.from.getTime())),
          }),
          to: new Date(date),
        }));
      },
      [range.from, onRangeChange]
    );

    return (
      <div className='flex justify-around space-x-2'>
        <DateInput value={range.from} onChange={handleFromChange} />
        <DateInput value={range.to} onChange={handleToChange} />
      </div>
    );
  }
);

DateRangeInputs.displayName = 'DateRangeInputs';
