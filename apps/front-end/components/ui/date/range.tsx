import type { DateRange } from './types';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Popover, PopoverContent } from '@/components/ui/popover';

import { DateActions } from './components/date-actions';
import { DateRangeCalendar } from './components/date-range-calendar';
import { DateRangeInputs } from './components/date-range-inputs';
import { DateTrigger } from './components/date-trigger';
import { PresetList } from './components/preset-list';
import { PresetSelect } from './components/preset-select';
import { DATE_PLACEHOLDER, DEFAULT_DATE_LOCALE } from './constants';
import { useDateRangeState } from './hooks/use-date-range-state';
import { formatDateRange } from './utils';

export interface DateRangePickerProps {
  initialDateFrom?: Date | string;
  initialDateTo?: Date | string;
  align?: 'start' | 'center' | 'end';
  locale?: string;
  onChange?: (range: DateRange) => void;
  title?: string;
  triggerClassName?: string;
  contentClassName?: string;
  placeholder?: string;
  showIcon?: boolean;
}

export const DateRangePicker = memo(
  ({
    initialDateFrom,
    initialDateTo,
    align = 'center',
    locale = DEFAULT_DATE_LOCALE,
    onChange,
    title,
    triggerClassName,
    contentClassName,
    placeholder,
    showIcon = false,
  }: DateRangePickerProps) => {
    const {
      isOpen,
      range,
      setRange,
      month,
      setMonth,
      selectedPreset,
      setPreset,
      isSmallScreen,
      handleOpenChange,
      handleSave,
      handleCancel,
    } = useDateRangeState({ initialDateFrom, initialDateTo, onChange });

    const label =
      formatDateRange(range, locale) ||
      placeholder ||
      title ||
      DATE_PLACEHOLDER;

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <DateTrigger
          label={label}
          triggerClassName={triggerClassName}
          showIcon={showIcon}
        />
        <PopoverContent
          align={align}
          className={cn('w-auto px-3 py-5', contentClassName)}
        >
          <div className='flex'>
            {!isSmallScreen && (
              <PresetList
                selectedPreset={selectedPreset}
                onPresetSelect={setPreset}
              />
            )}
            <div className='flex flex-col'>
              <DateRangeInputs range={range} onRangeChange={setRange} />
              {isSmallScreen && (
                <PresetSelect
                  selectedPreset={selectedPreset}
                  onPresetSelect={setPreset}
                />
              )}
              <DateRangeCalendar
                range={range}
                isSmallScreen={isSmallScreen}
                month={month}
                onMonthChange={setMonth}
                onRangeChange={setRange}
              />
            </div>
          </div>
          <DateActions onCancel={handleCancel} onSave={handleSave} />
        </PopoverContent>
      </Popover>
    );
  }
);

DateRangePicker.displayName = 'DateRangePicker';
