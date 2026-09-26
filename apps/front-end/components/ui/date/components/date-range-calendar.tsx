import type { DateRange, DateRangeUpdate } from '../types';
import type { DateRange as DayPickerRange } from '@daypicker/react';

import { memo, useCallback } from 'react';

import { Calendar } from '@/components/ui/calendar';

interface DateRangeCalendarProps {
  range: DateRange;
  isSmallScreen: boolean;
  month: Date;
  onMonthChange: (month: Date) => void;
  onRangeChange: (update: DateRangeUpdate) => void;
}

export const DateRangeCalendar = memo(
  ({
    range,
    isSmallScreen,
    month,
    onMonthChange,
    onRangeChange,
  }: DateRangeCalendarProps) => {
    const handleSelect = useCallback(
      (value: DayPickerRange | undefined) => {
        if (value?.from) onRangeChange({ from: value.from, to: value.to });
      },
      [onRangeChange]
    );

    return (
      <Calendar
        mode='range'
        onSelect={handleSelect}
        month={month}
        onMonthChange={onMonthChange}
        selected={range}
        numberOfMonths={isSmallScreen ? 1 : 2}
        className='mx-auto p-0 pt-2 lg:pe-2'
      />
    );
  }
);

DateRangeCalendar.displayName = 'DateRangeCalendar';
