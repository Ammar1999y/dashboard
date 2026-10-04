'use client';

import type { TDateElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useCallback } from 'react';

import { PlateElement, useReadOnly } from 'platejs/react';
import { safeDate } from '@app/shared/time';
import { cn } from '@/lib/utils';

import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { formatDateLabel } from '@/components/editor/date';
import { DATE_CLASS } from '@/components/editor/styles';

export function DateElement(props: PlateElementProps<TDateElement>) {
  const { editor, element } = props;
  const readOnly = useReadOnly();

  const handleSelect = useCallback(
    (date: Date | undefined) => {
      if (date)
        editor.tf.setNodes({ date: date.toDateString() }, { at: element });
    },
    [editor, element]
  );

  const label = (
    <span
      className={cn(DATE_CLASS, !readOnly && 'cursor-pointer')}
      contentEditable={false}
      draggable
    >
      {formatDateLabel(element.date)}
    </span>
  );

  return (
    <PlateElement
      {...props}
      attributes={{ ...props.attributes, contentEditable: false }}
      className='inline-block'
    >
      {readOnly ? (
        label
      ) : (
        <Popover>
          <PopoverTrigger asChild>{label}</PopoverTrigger>
          <PopoverContent className='w-auto p-0'>
            <Calendar
              autoFocus
              mode='single'
              onSelect={handleSelect}
              selected={safeDate(element.date) ?? undefined}
            />
          </PopoverContent>
        </Popover>
      )}
      {props.children}
    </PlateElement>
  );
}
