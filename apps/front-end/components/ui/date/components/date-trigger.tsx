import { memo } from 'react';

import { cn } from '@/lib/utils';

import { fieldSurface } from '@/components/ui/field-surface';
import { Icon } from '@/components/ui/icon';
import { PopoverTrigger } from '@/components/ui/popover';

interface DateTriggerProps {
  label: string;
  /** Replaces the default field styling, chevron included. */
  triggerClassName?: string;
  showIcon?: boolean;
}

export const DateTrigger = memo(
  ({ label, triggerClassName, showIcon }: DateTriggerProps) => (
    <PopoverTrigger asChild>
      <button
        type='button'
        className={cn('relative flex h-9 items-center', triggerClassName)}
      >
        {showIcon && (
          <Icon
            icon='solar:calendar-linear'
            className='absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground ltr:left-3 rtl:right-3'
          />
        )}
        <div
          className={cn(
            'flex h-full w-full items-center justify-between',
            !triggerClassName && [fieldSurface, 'px-3 py-2 text-sm']
          )}
        >
          <span className='truncate text-start'>{label}</span>
          {!triggerClassName && (
            <Icon
              icon='solar:alt-arrow-down-linear'
              className='ms-2 size-4 opacity-50'
            />
          )}
        </div>
      </button>
    </PopoverTrigger>
  )
);

DateTrigger.displayName = 'DateTrigger';
