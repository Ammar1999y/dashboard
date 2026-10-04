import type {
  FilterColumnSpecs,
  FilterColumnType,
} from '@app/shared/data-table/column-specs';
import type {
  FilterItemSchema,
  GetDataSchema,
} from '@app/shared/data-table/parsers';
import type { PaginationMeta } from '@app/shared/types/api';
import type { FilterVariant } from '@app/shared/types/data-table';

import { isNoValueOperator } from '@app/shared/data-table/column-specs';
import {
  assertFilterAllowed,
  dayBounds,
  dayRangeBounds,
  invalidFilter,
  isStringLike,
  numberRangeBounds,
  parseBoolean,
  requireFilterSpec,
  safeNumber,
} from '@app/shared/data-table/filter-rules';
import { effectiveSearchTerm } from '@app/shared/data-table/parsers';
import { safeDate } from '@app/shared/time';

/** A table's full query: what the server parses from the URL, plus the quick search. */
export type TableQuery = Omit<GetDataSchema, 'maxPerPage'> & { search: string };

export interface TableQueryOptions {
  /** Columns the quick search matches against. */
  searchableColumns: string[];
  /**
   * The server's descriptors, which validate every filter as the server does.
   * Without them a filter is read by its variant and only its values are checked.
   */
  filterableColumns?: FilterColumnSpecs;
}

const TYPE_OF_VARIANT: Record<FilterVariant, FilterColumnType> = {
  text: 'text',
  number: 'number',
  range: 'number',
  date: 'date',
  boolean: 'boolean',
  select: 'select',
  multiSelect: 'multiSelect',
};

type Predicate = (cell: unknown) => boolean;

const isNull = (cell: unknown) => cell === null || cell === undefined;

function textOf(cell: unknown): string | null {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean')
    return String(cell);
  return null;
}

function numberOf(cell: unknown): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  return safeNumber(cell);
}

function instantOf(cell: unknown): number | null {
  if (
    typeof cell !== 'string' &&
    typeof cell !== 'number' &&
    !(cell instanceof Date)
  )
    return null;
  return safeDate(cell)?.getTime() ?? null;
}

function scalarOf(value: string | string[]): string {
  return typeof value === 'string' ? value : invalidFilter();
}

/**
 * No value chosen yet. The client parser drops an empty scalar and the server
 * skips an empty range or set; neither is a condition.
 */
function isUnexpressed({ operator, value }: FilterItemSchema): boolean {
  if (isNoValueOperator(operator)) return false;
  return Array.isArray(value) ? !value.some(Boolean) : value === '';
}

function searchPredicate(
  operator: 'iLike' | 'notILike' | 'startsWith' | 'endsWith',
  value: string
): Predicate {
  const term = value.toLowerCase();
  const holds = (text: string) => {
    if (operator === 'startsWith') return text.startsWith(term);
    if (operator === 'endsWith') return text.endsWith(term);
    return text.includes(term);
  };
  return operator === 'notILike'
    ? (cell) => {
        const text = textOf(cell);
        return text === null || !holds(text.toLowerCase());
      }
    : (cell) => {
        const text = textOf(cell);
        return text !== null && holds(text.toLowerCase());
      };
}

/** The value of one cell as the column type reads it; `null` is SQL NULL. */
function readerOf(type: FilterColumnType): (cell: unknown) => unknown {
  if (type === 'boolean') return parseBoolean;
  if (type === 'number') return numberOf;
  return textOf;
}

/** A filter value as the column type compares it; uncoercible is a 422. */
function parseValue(type: FilterColumnType, raw: string): unknown {
  if (type === 'boolean') return parseBoolean(raw) ?? invalidFilter();
  if (type === 'number') return safeNumber(raw) ?? invalidFilter();
  return raw;
}

/**
 * One filter as the predicate the server's SQL expresses, under the same
 * three-valued logic: NULL fails every comparison and satisfies every negated
 * form, which is why those add `isNull` on the server. Values are parsed here,
 * once, so a malformed one throws before any row is read.
 */
function toPredicate(
  filter: FilterItemSchema,
  type: FilterColumnType
): Predicate {
  const { operator, value } = filter;

  switch (operator) {
    case 'iLike':
    case 'notILike':
    case 'startsWith':
    case 'endsWith': {
      return searchPredicate(operator, scalarOf(value));
    }

    case 'eq':
    case 'ne': {
      const negated = operator === 'ne';
      if (type === 'date') {
        const { start, next } = dayBounds(value);
        const within = (time: number) =>
          time >= start.getTime() && time < next.getTime();
        return (cell) => {
          const time = instantOf(cell);
          if (time === null) return negated;
          return within(time) !== negated;
        };
      }
      const target = parseValue(type, scalarOf(value));
      const read = readerOf(type);
      return (cell) => {
        const current = read(cell);
        if (current === null) return negated;
        return (current === target) !== negated;
      };
    }

    case 'inArray':
    case 'notInArray': {
      const negated = operator === 'notInArray';
      if (!Array.isArray(value)) invalidFilter();
      const members = value.filter(Boolean);
      if (members.length === 0) invalidFilter();
      const set = new Set(members.map((member) => parseValue(type, member)));
      const read = readerOf(type);
      return (cell) => {
        const current = read(cell);
        if (current === null) return negated;
        return set.has(current) !== negated;
      };
    }

    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (type === 'date') {
        const { start, next } = dayBounds(value);
        const bound = {
          lt: start.getTime(),
          lte: next.getTime(),
          gt: next.getTime(),
          gte: start.getTime(),
        }[operator];
        const below = operator === 'lt' || operator === 'lte';
        return (cell) => {
          const time = instantOf(cell);
          if (time === null) return false;
          return below ? time < bound : time >= bound;
        };
      }
      const bound = safeNumber(value) ?? invalidFilter();
      return (cell) => {
        const current = numberOf(cell);
        if (current === null) return false;
        if (operator === 'lt') return current < bound;
        if (operator === 'lte') return current <= bound;
        if (operator === 'gt') return current > bound;
        return current >= bound;
      };
    }

    case 'isBetween': {
      if (!Array.isArray(value)) invalidFilter();
      if (type === 'date') {
        const { start, next } = dayRangeBounds(value);
        return (cell) => {
          const time = instantOf(cell);
          if (time === null) return false;
          return (
            (start === null || time >= start.getTime()) &&
            (next === null || time < next.getTime())
          );
        };
      }
      const { lower, upper } = numberRangeBounds(value);
      return (cell) => {
        const current = numberOf(cell);
        if (current === null) return false;
        return (
          (lower === null || current >= lower) &&
          (upper === null || current <= upper)
        );
      };
    }

    case 'isEmpty':
    case 'isNotEmpty': {
      const stringLike = isStringLike({ type });
      const empty = (cell: unknown) =>
        isNull(cell) || (stringLike && cell === '');
      return operator === 'isEmpty' ? empty : (cell) => !empty(cell);
    }
  }
}

/**
 * PostgreSQL's default order: NULL sorts above every value, so it comes last
 * ascending and first descending.
 */
function compareCells(a: unknown, b: unknown): number {
  const aNull = isNull(a);
  const bNull = isNull(b);
  if (aNull || bNull) {
    if (aNull === bNull) return 0;
    return aNull ? 1 : -1;
  }
  if (
    (typeof a === 'number' && typeof b === 'number') ||
    (typeof a === 'boolean' && typeof b === 'boolean')
  ) {
    const [x, y] = [Number(a), Number(b)];
    if (x < y) return -1;
    return x > y ? 1 : 0;
  }
  return String(a).localeCompare(String(b), 'ar');
}

const cellOf = (row: object, id: string): unknown =>
  Object.hasOwn(row, id) ? (row as Record<string, unknown>)[id] : undefined;

/**
 * The server-side table contract — search, filters, sort and one page with
 * its `meta` — run over rows already in memory. The mock API answers with it
 * and a client-side table applies it, so both behave as the server does.
 *
 * Throws the server's 422 `CustomError` for a filter the server refuses.
 */
export function queryRows<T extends object>(
  rows: T[],
  { page, perPage, sort, filters, joinOperator, search }: TableQuery,
  { searchableColumns, filterableColumns }: TableQueryOptions
): { data: T[]; meta: PaginationMeta } {
  const predicates: { id: string; holds: Predicate }[] = [];
  for (const filter of filters) {
    if (filterableColumns) {
      const spec = requireFilterSpec(filterableColumns, filter.id);
      if (assertFilterAllowed(filter, spec) === 'skip') continue;
      predicates.push({ id: filter.id, holds: toPredicate(filter, spec.type) });
    } else if (!isUnexpressed(filter)) {
      predicates.push({
        id: filter.id,
        holds: toPredicate(filter, TYPE_OF_VARIANT[filter.variant]),
      });
    }
  }

  let result = rows;

  if (predicates.length > 0) {
    const matches = (row: T) =>
      joinOperator === 'or'
        ? predicates.some(({ id, holds }) => holds(cellOf(row, id)))
        : predicates.every(({ id, holds }) => holds(cellOf(row, id)));
    result = result.filter(matches);
  }

  const term = effectiveSearchTerm(search).toLowerCase();
  if (term && searchableColumns.length > 0) {
    result = result.filter((row) =>
      searchableColumns.some((id) =>
        textOf(cellOf(row, id))?.toLowerCase().includes(term)
      )
    );
  }

  // The server's tie-breaker, so rows sharing a sort value page the same way.
  const order = sort.some((s) => s.id === 'id')
    ? sort
    : [...sort, { id: 'id', desc: true }];
  result = [...result].sort((a, b) => {
    for (const { id, desc } of order) {
      const diff = compareCells(cellOf(a, id), cellOf(b, id));
      if (diff !== 0) return desc ? -diff : diff;
    }
    return 0;
  });

  const total = result.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  return {
    data: result.slice((page - 1) * perPage, page * perPage),
    meta: { page, perPage, total, pageCount },
  };
}
