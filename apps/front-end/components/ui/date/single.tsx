import { memo, useCallback } from 'react';

import { cn } from '@/lib/utils';

import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent } from '@/components/ui/popover';

import { DateActions } from './components/date-actions';
import { DateTrigger } from './components/date-trigger';
import { DATE_PLACEHOLDER, DEFAULT_DATE_LOCALE } from './constants';
import { DateInput } from './date-input';
import { useDatePopoverState } from './hooks/use-date-popover-state';
import { formatDate, parseInitialDate } from './utils';

export interface SingleDatePickerProps {
  initialDate?: Date | string;
  align?: 'start' | 'center' | 'end';
  locale?: string;
  onChange?: (date: Date | undefined) => void;
  title?: string;
  triggerClassName?: string;
  contentClassName?: string;
  placeholder?: string;
  showIcon?: boolean;
}

const dateAnchor = (date: Date | undefined) => date;
const today = () => new Date();

export const SingleDatePicker = memo(
  ({
    initialDate,
    align = 'center',
    locale = DEFAULT_DATE_LOCALE,
    onChange,
    title,
    triggerClassName,
    contentClassName,
    placeholder,
    showIcon = false,
  }: SingleDatePickerProps) => {
    const {
      isOpen,
      value: date,
      setDraft: setDate,
      month,
      setMonth,
      handleOpenChange,
      handleSave,
      handleCancel,
    } = useDatePopoverState<Date | undefined>({
      initialValue: () => parseInitialDate(initialDate),
      anchorOf: dateAnchor,
      fallbackMonth: today,
      onChange,
    });

    const label = date
      ? formatDate(date, locale)
      : placeholder || title || DATE_PLACEHOLDER;

    const handleSelect = useCallback(
      (value: Date | undefined) => {
        if (value) setDate(value);
      },
      [setDate]
    );

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
          <div className='flex flex-col'>
            <div className='flex justify-center'>
              <DateInput value={date} onChange={setDate} />
            </div>
            <Calendar
              mode='single'
              selected={date}
              onSelect={handleSelect}
              month={month}
              onMonthChange={setMonth}
              numberOfMonths={1}
              className='mx-auto p-0 pt-2'
            />
          </div>
          <DateActions onCancel={handleCancel} onSave={handleSave} />
        </PopoverContent>
      </Popover>
    );
  }
);

SingleDatePicker.displayName = 'SingleDatePicker';
