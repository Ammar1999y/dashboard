import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface DateInputProps {
  value?: Date;
  /** `undefined` means the user cleared every field. */
  onChange: (date: Date | undefined) => void;
  className?: string;
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const daysInMonth = (y: number, m1to12: number) =>
  new Date(y, m1to12, 0).getDate();

type DParts = { day: string; month: string; year: string };

// No value is a real state (an open-ended range), never defaulted to today.
const EMPTY_PARTS: DParts = { day: '', month: '', year: '' };

const toPartsFromDate = (d: Date): DParts => ({
  day: pad2(d.getDate()),
  month: pad2(d.getMonth() + 1),
  year: d.getFullYear().toString(),
});

const toDateFromParts = (p: DParts) =>
  new Date(Number(p.year), Number(p.month) - 1, Number(p.day));

// De-duplicates emissions. Numeric so `'5'` and `'05'` are the same day.
const partsKey = (p: DParts) =>
  `${Number(p.year)}-${Number(p.month)}-${Number(p.day)}`;
const CLEARED_KEY = 'cleared';

/**
 * A single digit is valid but not committed: emitting `1` would echo back
 * padded to `01` and `maxLength` would refuse the `5` of `15`. Blur pads and
 * commits it; two digits commit at once.
 */
const isCommittableParts = (d: DParts) =>
  d.day.length === 2 && d.month.length === 2 && d.year.length === 4;

const isValidParts = (d: DParts) => {
  const day = Number(d.day);
  const month = Number(d.month);
  const year = Number(d.year);
  if (
    !Number.isSafeInteger(day) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(year) ||
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12
  )
    return false;
  return day >= 1 && day <= daysInMonth(year, month);
};

const adjust = (parts: DParts, field: keyof DParts, step: 1 | -1): DParts => {
  // Missing parts start from today, so the arrows can also begin an entry.
  const today = new Date();
  const y = Number(parts.year) || today.getFullYear();
  const m = (Number(parts.month) || today.getMonth() + 1) - 1;
  const d = Number(parts.day) || today.getDate();

  let dt = new Date(y, m, d);

  if (field === 'day') {
    dt.setDate(dt.getDate() + step);
  } else if (field === 'month') {
    const origDay = dt.getDate();
    dt.setDate(1);
    dt.setMonth(dt.getMonth() + step);

    const dim = daysInMonth(dt.getFullYear(), dt.getMonth() + 1);
    dt.setDate(Math.min(origDay, dim));
  } else {
    const newY = Math.min(9999, Math.max(1000, dt.getFullYear() + step));
    const dim = daysInMonth(newY, dt.getMonth() + 1);
    dt = new Date(newY, dt.getMonth(), Math.min(dt.getDate(), dim));
  }

  const boundedYear = Math.min(9999, Math.max(1000, dt.getFullYear()));
  dt = new Date(boundedYear, dt.getMonth(), dt.getDate());

  return toPartsFromDate(dt);
};
const DateInput = memo<DateInputProps>(({ value, onChange, className }) => {
  const [date, setDate] = useState<DParts>(() =>
    value ? toPartsFromDate(new Date(value)) : EMPTY_PARTS
  );
  const lastValidRef = useRef<DParts>(date);
  // The owner already holds its value, so re-entering it is not a change.
  // Completing a field focuses the next, whose blur fires with a stale
  // closure; this is what keeps that from emitting the same date twice.
  const lastEmittedRef = useRef<string>(value ? partsKey(date) : CLEARED_KEY);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dayRef = useRef<HTMLInputElement | null>(null);
  const monthRef = useRef<HTMLInputElement | null>(null);
  const yearRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const next = value ? toPartsFromDate(new Date(value)) : EMPTY_PARTS;
    lastValidRef.current = next;
    // Must follow the incoming value, or retyping a date this input emitted
    // before the owner changed it elsewhere is dropped as a duplicate.
    lastEmittedRef.current = value ? partsKey(next) : CLEARED_KEY;
    setDate(next);
  }, [value]);

  // The single place a change is reported, for both terminal states — a
  // complete date and a fully empty one — as they happen, not on blur.
  const setAndMaybeEmit = (next: DParts) => {
    if (
      next.day === date.day &&
      next.month === date.month &&
      next.year === date.year
    )
      return;
    setDate(next);

    if (!next.day && !next.month && !next.year) {
      lastValidRef.current = EMPTY_PARTS;
      // Tabbing across an empty input blurs each field; report it once.
      if (lastEmittedRef.current === CLEARED_KEY) return;
      lastEmittedRef.current = CLEARED_KEY;
      onChange(undefined);
      return;
    }

    if (isValidParts(next)) {
      lastValidRef.current = next;
      if (!isCommittableParts(next)) return;
      const key = partsKey(next);
      if (lastEmittedRef.current === key) return;
      lastEmittedRef.current = key;
      onChange(toDateFromParts(next));
    }
  };

  const handleInputChange =
    (field: keyof DParts) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.replace(/\D/g, '');
      const maxLen = field === 'year' ? 4 : 2;
      const next = { ...date, [field]: raw.slice(0, maxLen) };
      setAndMaybeEmit(next);

      if (raw.length === maxLen) {
        if (field === 'day') monthRef.current?.focus();
        else if (field === 'month') yearRef.current?.focus();
      }
    };

  const handleBlur =
    (field: keyof DParts) => (e: React.FocusEvent<HTMLInputElement>) => {
      // Pads only the field being left: padding empty siblings would fail a
      // partial date's validation and reset it on every day → month move.
      const raw = e.target.value;
      const padded = raw ? pad2(Number(raw) || 0) : '';
      const next: DParts = {
        day: field === 'day' ? padded : date.day,
        month: field === 'month' ? padded : date.month,
        year: field === 'year' ? raw : date.year,
      };

      if (!next.day && !next.month && !next.year) return setAndMaybeEmit(next);

      // Only a complete but impossible date (31/02) is rejected.
      const complete = !!next.day && !!next.month && next.year.length === 4;
      if (complete && !isValidParts(next)) {
        setDate(lastValidRef.current);
        return;
      }

      setAndMaybeEmit(next);
    };

  const handleKeyDown =
    (field: keyof DParts) => (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.metaKey || e.ctrlKey) return;

      const allowed = [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Delete',
        'Tab',
        'Backspace',
        'Enter',
      ];
      if (!/^\d$/.test(e.key) && !allowed.includes(e.key)) {
        e.preventDefault();
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = adjust(date, field, e.key === 'ArrowUp' ? 1 : -1);
        setAndMaybeEmit(next);
        return;
      }

      const selStart = e.currentTarget.selectionStart ?? 0;
      const selEnd = e.currentTarget.selectionEnd ?? 0;
      if (e.key === 'ArrowRight') {
        if (
          selStart === e.currentTarget.value.length ||
          (selStart === 0 && selEnd === e.currentTarget.value.length)
        ) {
          e.preventDefault();
          if (field === 'month') dayRef.current?.focus();
          else if (field === 'year') monthRef.current?.focus();
        }
      } else if (
        e.key === 'ArrowLeft' &&
        (selStart === 0 ||
          (selStart === 0 && selEnd === e.currentTarget.value.length))
      ) {
        e.preventDefault();
        if (field === 'day') monthRef.current?.focus();
        else if (field === 'month') yearRef.current?.focus();
      }
    };

  // Leaving the whole control — not moving between its fields — discards an
  // unfinished date, which the owner never saw and Save would not commit.
  const handleContainerBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && containerRef.current?.contains(e.relatedTarget))
      return;

    const hasAnyInput = !!(date.day || date.month || date.year);
    if (hasAnyInput && !isValidParts(date)) setDate(lastValidRef.current);
  };

  const onClick = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
    e.preventDefault();
  }, []);
  const onFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    if (typeof window !== 'undefined' && window.innerWidth > 1024)
      e.target.select();
  }, []);
  return (
    <div
      ref={containerRef}
      onBlur={handleContainerBlur}
      className={cn(
        'num flex items-center rounded border p-1 text-sm',
        className
      )}
    >
      <input
        type='text'
        ref={dayRef}
        inputMode='numeric'
        pattern='[0-9]*'
        maxLength={2}
        value={date.day}
        onChange={handleInputChange('day')}
        onKeyDown={handleKeyDown('day')}
        onFocus={onFocus}
        onClick={onClick}
        dir='ltr'
        onBlur={handleBlur('day')}
        className='bidi-isolate w-7 border-none p-0 text-center caret-primary outline-none'
        placeholder='D'
        aria-label='Day'
      />
      <span className='-mx-px opacity-20'>/</span>
      <input
        type='text'
        ref={monthRef}
        dir='ltr'
        inputMode='numeric'
        pattern='[0-9]*'
        maxLength={2}
        value={date.month}
        onChange={handleInputChange('month')}
        onKeyDown={handleKeyDown('month')}
        onFocus={onFocus}
        onClick={onClick}
        onBlur={handleBlur('month')}
        className='bidi-isolate w-6 border-none p-0 text-center caret-primary outline-none'
        placeholder='M'
        aria-label='Month'
      />
      <span className='-mx-px opacity-20'>/</span>
      <input
        type='text'
        dir='ltr'
        ref={yearRef}
        inputMode='numeric'
        pattern='[0-9]*'
        maxLength={4}
        value={date.year}
        onChange={handleInputChange('year')}
        onKeyDown={handleKeyDown('year')}
        onFocus={onFocus}
        onClick={onClick}
        onBlur={handleBlur('year')}
        className='bidi-isolate w-12 border-none p-0 text-center caret-primary outline-none'
        placeholder='YYYY'
        aria-label='Year'
      />
    </div>
  );
});

DateInput.displayName = 'DateInput';

export { DateInput };
