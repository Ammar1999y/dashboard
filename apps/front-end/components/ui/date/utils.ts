import type { PresetName } from './constants';
import type { DateRange } from './types';

import { calendarDayInZone, safeDate } from '@app/shared/time';

import { DEFAULT_DATE_LOCALE } from './constants';

export const formatDate = (
  date: Date,
  locale: string = DEFAULT_DATE_LOCALE
): string =>
  date.toLocaleDateString(locale, {
    day: '2-digit',
    month: 'numeric',
    year: 'numeric',
    numberingSystem: 'latn',
  });

/** Empty only when neither bound is set: an upper-only range still filters. */
export const formatDateRange = (range: DateRange, locale: string): string => {
  const from = range.from ? formatDate(range.from, locale) : '';
  const to = range.to ? formatDate(range.to, locale) : '';
  if (from && to && from !== to) return `${from} - ${to}`;
  return from || to;
};

/**
 * A stored timestamp as its BUSINESS_TIMEZONE calendar day — the zone the
 * server resolves date filters in, so a row never displays outside the range
 * that matched it.
 */
export const tableFormatDate = (date: string | null): string => {
  if (!date) return '-';
  const parsed = safeDate(date);
  if (!parsed) return '-';
  return calendarDayInZone(parsed);
};

/**
 * A `YYYY-MM-DD` string is a calendar day, so it becomes local midnight of
 * that day — `new Date('2026-08-02')` would be UTC midnight, the previous day
 * west of UTC. Anything else is parsed as an instant; an invalid input is no
 * date rather than an `Invalid Date`.
 */
export const parseInitialDate = (
  input: Date | string | undefined
): Date | undefined => {
  if (!input) return undefined;
  if (typeof input !== 'string') return input;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (match) return new Date(+match[1], +match[2] - 1, +match[3]);
  return safeDate(input) ?? undefined;
};

/**
 * "Today" in BUSINESS_TIMEZONE, as a local `Date` at midnight of that day, so
 * presets never follow the browser's calendar day while the preset arithmetic
 * stays in local time.
 */
const businessToday = (): Date => {
  const [year, month, day] = calendarDayInZone(new Date())
    .split('-')
    .map(Number);
  return new Date(year, month - 1, day);
};

export const getPresetRange = (
  presetName: PresetName
): { from: Date; to: Date } => {
  const from = businessToday();
  const to = businessToday();
  const first = from.getDate() - from.getDay();

  switch (presetName) {
    case 'today': {
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case 'yesterday': {
      from.setDate(from.getDate() - 1);
      from.setHours(0, 0, 0, 0);
      to.setDate(to.getDate() - 1);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case 'last7': {
      from.setDate(from.getDate() - 6);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case 'thisWeek': {
      from.setDate(first);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case 'lastWeek': {
      from.setDate(from.getDate() - 7 - from.getDay());
      to.setDate(to.getDate() - to.getDay() - 1);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case 'thisMonth': {
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    }
    case 'lastMonth': {
      // Anchor to the 1st before shifting: `setMonth` from a day the target
      // month lacks overflows forward (Mar 31 → Mar 3).
      from.setDate(1);
      from.setMonth(from.getMonth() - 1);
      from.setHours(0, 0, 0, 0);
      to.setDate(1);
      to.setDate(0);
      to.setHours(23, 59, 59, 999);
      break;
    }
  }

  return { from, to };
};
