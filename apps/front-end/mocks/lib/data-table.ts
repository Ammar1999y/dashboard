import type { FilterItemSchema } from '@/lib/data-table/parsers';
import type { PaginationMeta } from '@/types/data-table';

import { MIN_SEARCH_LENGTH, parseSearchParams } from '@/lib/data-table/parsers';

interface TableOptions<T> {
  /** Columns the quick search box matches against. */
  searchFields: (keyof T & string)[];
  /** Applied when the request names no sort, as the server does. */
  defaultSort?: { id: string; desc: boolean };
  /** For a column whose cell is not a plain value — an embedded object. */
  columns?: Partial<Record<string, (row: T) => unknown>>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Filters send a local calendar day, so a timestamp is compared as one. */
function calendarDay(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const text = (value: unknown) =>
  value === null || value === undefined ? '' : String(value).toLowerCase();

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }
  return text(a).localeCompare(text(b), 'ar');
}

function matches(cell: unknown, filter: FilterItemSchema): boolean {
  const isDate = filter.variant === 'date';
  const isNumber = filter.variant === 'number' || filter.variant === 'range';
  const key = isDate ? calendarDay(cell) : isNumber ? Number(cell) : text(cell);
  const values = (
    Array.isArray(filter.value) ? filter.value : [filter.value]
  ).map((v) => (isNumber ? Number(v) : isDate ? v : v.toLowerCase()));
  const [first, second] = values;
  const keyText = String(key);

  switch (filter.operator) {
    case 'isEmpty': {
      return text(cell) === '';
    }
    case 'isNotEmpty': {
      return text(cell) !== '';
    }
    case 'iLike': {
      return keyText.includes(String(first));
    }
    case 'notILike': {
      return !keyText.includes(String(first));
    }
    case 'startsWith': {
      return keyText.startsWith(String(first));
    }
    case 'endsWith': {
      return keyText.endsWith(String(first));
    }
    case 'eq': {
      return compare(key, first) === 0;
    }
    case 'ne': {
      return compare(key, first) !== 0;
    }
    case 'inArray': {
      return values.some((v) => compare(key, v) === 0);
    }
    case 'notInArray': {
      return !values.some((v) => compare(key, v) === 0);
    }
    case 'lt': {
      return compare(key, first) < 0;
    }
    case 'lte': {
      return compare(key, first) <= 0;
    }
    case 'gt': {
      return compare(key, first) > 0;
    }
    case 'gte': {
      return compare(key, first) >= 0;
    }
    case 'isBetween': {
      return compare(key, first) >= 0 && compare(key, second) <= 0;
    }
  }
}

/**
 * The server-side table contract `useServerDataTable` speaks: the same URL
 * parameters, answered with one page and its `meta`.
 */
export function queryTable<T extends object>(
  rows: T[],
  url: URL,
  { searchFields, defaultSort, columns = {} }: TableOptions<T>
): { data: T[]; meta: PaginationMeta } {
  const { page, perPage, sort, filters, joinOperator } = parseSearchParams(
    Object.fromEntries(url.searchParams)
  );
  const search = text(url.searchParams.get('search')).trim();

  const cell = (row: T, id: string) =>
    columns[id]?.(row) ?? (row as Record<string, unknown>)[id];

  let result = rows;

  if (search.length >= MIN_SEARCH_LENGTH) {
    result = result.filter((row) =>
      searchFields.some((field) => text(row[field]).includes(search))
    );
  }

  if (filters.length > 0) {
    result = result.filter((row) =>
      joinOperator === 'or'
        ? filters.some((f) => matches(cell(row, f.id), f))
        : filters.every((f) => matches(cell(row, f.id), f))
    );
  }

  const order = sort.length > 0 ? sort : defaultSort ? [defaultSort] : [];
  if (order.length > 0) {
    result = [...result].sort((a, b) => {
      for (const { id, desc } of order) {
        const diff = compare(cell(a, id), cell(b, id));
        if (diff !== 0) return desc ? -diff : diff;
      }
      return 0;
    });
  }

  const total = result.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  return {
    data: result.slice((page - 1) * perPage, page * perPage),
    meta: { page, perPage, total, pageCount },
  };
}
