import {
  addDays,
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  isSameDay,
} from 'date-fns';
import { safeDate } from '@app/shared/time';

import { formatDate, formatLongDate, formatRelativeTime } from '@/utils/format';

export const EMPTY_DATE_LABEL = 'اختر تاريخ';

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
  return relative ? relative[1] : formatLongDate(date);
}

/** A comment's age: relative within a day or two, then the calendar date. */
export function formatCommentDate(date: Date, now = new Date()): string {
  const minutes = differenceInMinutes(now, date);
  if (minutes < 60) return formatRelativeTime(-minutes, 'minute');

  const hours = differenceInHours(now, date);
  if (hours < 24) return formatRelativeTime(-hours, 'hour');

  const days = differenceInDays(now, date);
  if (days < 2) return formatRelativeTime(-days, 'day');

  return formatDate(date);
}
