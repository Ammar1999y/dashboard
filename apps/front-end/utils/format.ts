import { BUSINESS_TIMEZONE } from '@app/shared/config';
import { calendarDayInZone, safeDate } from '@app/shared/time';

// The one place the app formats a number or a date for display; ESLint keeps
// `Intl` and `toLocale*String` out of every other file.

/**
 * Arabic on the Gregorian calendar, in Latin digits. The digits are pinned in
 * the tag: what a bare `ar` gives differs by engine and version (Arabic-Indic
 * in Safari before iOS 18, Latin in Chrome), and `ar-SA` is Arabic-Indic.
 */
export const DISPLAY_LOCALE = 'ar-u-ca-gregory-nu-latn';

const integerFormat = new Intl.NumberFormat(DISPLAY_LOCALE, {
  maximumFractionDigits: 0,
});

/**
 * A whole number with grouping, `1,234,567`. A negative one starts with the
 * mark that keeps its sign in front inside RTL text.
 */
export const formatInteger = (value: number) => integerFormat.format(value);

/** A picked day in the locale's numeric order, as the date pickers show it. */
export const formatDate = (date: Date, locale: string = DISPLAY_LOCALE) =>
  // The option, not only the tag: a caller's `locale` may not pin the digits.
  date.toLocaleDateString(locale, {
    day: '2-digit',
    month: 'numeric',
    year: 'numeric',
    numberingSystem: 'latn',
  });

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

const dateTimeFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: BUSINESS_TIMEZONE,
});

/** A stored timestamp as a date and time in BUSINESS_TIMEZONE; `null` when it is no date. */
export const formatDateTime = (value: string | null | undefined) => {
  const date = safeDate(value);
  return date ? dateTimeFormat.format(date) : null;
};

const longDateFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** A day with its month name, `8 أكتوبر 2026`. */
export const formatLongDate = (date: Date) => longDateFormat.format(date);

const monthFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, { month: 'long' });

export const formatMonth = (date: Date) => monthFormat.format(date);

const monthYearFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  month: 'long',
  year: 'numeric',
});

export const formatMonthYear = (date: Date) => monthYearFormat.format(date);

const relativeTimeFormat = new Intl.RelativeTimeFormat(DISPLAY_LOCALE, {
  numeric: 'auto',
  style: 'narrow',
});

/** `value` units from now, negative for the past: `قبل 5 دقائق`, `أمس`. */
export const formatRelativeTime = (
  value: number,
  unit: Intl.RelativeTimeFormatUnit
) => relativeTimeFormat.format(value, unit);
