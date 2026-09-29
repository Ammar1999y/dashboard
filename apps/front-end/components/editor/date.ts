import {
  addDays,
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  format,
  isSameDay,
} from 'date-fns';

import { safeDate } from '@/utils/time';

export const EMPTY_DATE_LABEL = 'اختر تاريخ';

const LONG_DATE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const RELATIVE_DAYS: [offset: number, label: string][] = [
  [0, 'اليوم'],
  [-1, 'أمس'],
  [1, 'غداً'],
];

/** A date node's `date`; `null` when missing or unreadable. */
export const readDate = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? safeDate(value)
    : null;

/** The label a date node shows; a missing or unreadable date asks for one. */
export function formatDateLabel(value: unknown, now = new Date()): string {
  const date = readDate(value);
  if (!date) return EMPTY_DATE_LABEL;

  const relative = RELATIVE_DAYS.find(([offset]) =>
    isSameDay(date, addDays(now, offset))
  );
  return relative ? relative[1] : LONG_DATE.format(date);
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat('ar', {
  numeric: 'auto',
  style: 'narrow',
});

/** A comment's age: relative within a day or two, then the calendar date. */
export function formatCommentDate(date: Date, now = new Date()): string {
  const minutes = differenceInMinutes(now, date);
  if (minutes < 60) return RELATIVE_TIME.format(-minutes, 'minute');

  const hours = differenceInHours(now, date);
  if (hours < 24) return RELATIVE_TIME.format(-hours, 'hour');

  const days = differenceInDays(now, date);
  if (days < 2) return RELATIVE_TIME.format(-days, 'day');

  return format(date, 'dd/MM/yyyy');
}
