import type {
  FilterColumnSpec,
  FilterColumnSpecs,
} from '@app/shared/data-table/column-specs';
import type {
  ExtendedColumnFilter,
  JoinOperator,
} from '@app/shared/types/data-table';
import type { SQL, Table } from 'drizzle-orm';

import {
  and,
  Column,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  is,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notIlike,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

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

/**
 * ⚠️ TEXT COLUMNS ONLY — see `isStringLike`. A bare boolean expression rather
 * than a `CASE`, because the planner can match only the former against an
 * index; the parentheses keep it intact under `and`/`or` composition.
 */
function isEmpty(column: Column) {
  return sql<boolean>`(${column} is null or ${column} = '')`;
}

/**
 * Its own expression rather than `not(isEmpty(column))`: `IS NOT NULL AND
 * <> ''` is what an index can be matched against, a negated disjunction is not.
 */
function isNotEmpty(column: Column) {
  return sql<boolean>`(${column} is not null and ${column} <> '')`;
}

export function escapeLike(value: string): string {
  return value.replaceAll(/[%_\\]/g, String.raw`\$&`);
}

// Every negated form below adds `or(..., isNull(column))`: under SQL
// three-valued logic `NULL <> x`, `NULL NOT ILIKE …` and `NULL NOT IN (…)` are
// NULL, not TRUE, so a row with no value would silently fail a predicate that
// plainly describes it — absent from the rows and from `meta.total`.
function buildCondition(
  column: Column,
  filter: ExtendedColumnFilter<Table>,
  spec: FilterColumnSpec
): SQL | undefined {
  const value = filter.value;

  switch (filter.operator) {
    case 'iLike': {
      return ilike(column, `%${escapeLike(value as string)}%`);
    }
    case 'notILike': {
      return or(
        notIlike(column, `%${escapeLike(value as string)}%`),
        isNull(column)
      );
    }
    case 'startsWith': {
      return ilike(column, `${escapeLike(value as string)}%`);
    }
    case 'endsWith': {
      return ilike(column, `%${escapeLike(value as string)}`);
    }

    case 'eq':
    case 'ne': {
      const negated = filter.operator === 'ne';

      if (spec.type === 'boolean') {
        const bool = parseBoolean(value);
        if (bool === null) invalidFilter();
        return negated
          ? or(ne(column, bool), isNull(column))
          : eq(column, bool);
      }
      if (spec.type === 'date') {
        const { start, next } = dayBounds(value);
        return negated
          ? or(lt(column, start), gte(column, next), isNull(column))
          : and(gte(column, start), lt(column, next));
      }
      if (spec.type === 'number') {
        const num = safeNumber(value);
        if (num === null) invalidFilter();
        return negated ? or(ne(column, num), isNull(column)) : eq(column, num);
      }
      return negated
        ? or(ne(column, value), isNull(column))
        : eq(column, value);
    }

    case 'inArray':
    case 'notInArray': {
      const negated = filter.operator === 'notInArray';
      // Set semantics: empty positional slots carry no meaning here.
      const values = (value as string[]).filter(Boolean);
      if (values.length === 0) invalidFilter();

      const excludeNulls = (condition: SQL) =>
        negated ? or(condition, isNull(column)) : condition;

      if (spec.type === 'boolean') {
        const bools = values.map(parseBoolean);
        if (bools.includes(null)) invalidFilter();
        return excludeNulls(
          negated
            ? notInArray(column, bools as boolean[])
            : inArray(column, bools as boolean[])
        );
      }
      if (spec.type === 'number') {
        const nums = values.map(safeNumber);
        if (nums.includes(null)) invalidFilter();
        return excludeNulls(
          negated
            ? notInArray(column, nums as number[])
            : inArray(column, nums as number[])
        );
      }
      return excludeNulls(
        negated ? notInArray(column, values) : inArray(column, values)
      );
    }

    // Comparison operators. For dates the labels are calendar-relative:
    // "before X" excludes X's day, "on or before X" includes all of it.
    case 'lt': {
      if (spec.type === 'date') return lt(column, dayBounds(value).start);
      return compareNumber(column, value, lt);
    }
    case 'lte': {
      if (spec.type === 'date') return lt(column, dayBounds(value).next);
      return compareNumber(column, value, lte);
    }
    case 'gt': {
      if (spec.type === 'date') return gte(column, dayBounds(value).next);
      return compareNumber(column, value, gt);
    }
    case 'gte': {
      if (spec.type === 'date') return gte(column, dayBounds(value).start);
      return compareNumber(column, value, gte);
    }

    // Ordered bounds with an open side for an empty slot; see the helpers.
    case 'isBetween': {
      if (spec.type === 'date') {
        const { start, next } = dayRangeBounds(value as string[]);
        return and(
          start ? gte(column, start) : undefined,
          next ? lt(column, next) : undefined
        );
      }

      const { lower, upper } = numberRangeBounds(value as string[]);
      if (lower !== null && upper !== null)
        return and(gte(column, lower), lte(column, upper));
      return lower === null ? lte(column, upper) : gte(column, lower);
    }

    // `''` is rejected outright on boolean/timestamp/numeric columns ("invalid
    // input syntax for type boolean"), so for those the only emptiness is NULL.
    case 'isEmpty': {
      return isStringLike(spec) ? isEmpty(column) : isNull(column);
    }
    case 'isNotEmpty': {
      return isStringLike(spec) ? isNotEmpty(column) : isNotNull(column);
    }

    default: {
      return invalidFilter();
    }
  }
}

function compareNumber(
  column: Column,
  value: unknown,
  op: typeof lt | typeof lte | typeof gt | typeof gte
): SQL {
  const num = safeNumber(value);
  if (num === null) invalidFilter();
  return op(column, num);
}

export function filterColumns<T extends Table>({
  table,
  filters,
  joinOperator,
  specs,
}: {
  table: T;
  filters: ExtendedColumnFilter<T>[];
  joinOperator: JoinOperator;
  /** Server-owned descriptors; a column without one is not filterable. */
  specs: FilterColumnSpecs;
}): SQL | undefined {
  const joinFn = joinOperator === 'and' ? and : or;

  const conditions: SQL[] = [];
  for (const filter of filters) {
    const spec = requireFilterSpec(specs, filter.id);

    const column = getColumn(table, filter.id);
    // A descriptor without a matching column is a server-side mismatch, not
    // something the client did — surface it as 500, not 422.
    if (!column)
      throw new Error(`Filterable column "${filter.id}" is not on the table`);

    const decision = assertFilterAllowed(
      filter as ExtendedColumnFilter<Table>,
      spec
    );
    if (decision === 'skip') continue;

    const condition = buildCondition(
      column,
      filter as ExtendedColumnFilter<Table>,
      spec
    );
    if (condition) conditions.push(condition);
  }

  return conditions.length > 0 ? joinFn(...conditions) : undefined;
}

/**
 * The column named by a CLIENT-SUPPLIED key, or `null`. `string`, not
 * `keyof T`: the key arrives from a query string.
 *
 * Reads `getTableColumns(table)` rather than the table object, so a key naming
 * one of Drizzle's own table members cannot resolve to something that is not a
 * column; `Object.hasOwn` because that record still carries `Object.prototype`;
 * `is(value, Column)` because it proves the shape rather than probing for one.
 */
export function getColumn(table: Table, columnKey: string): Column | null {
  const columns: Record<string, unknown> = getTableColumns(table);
  if (!Object.hasOwn(columns, columnKey)) return null;
  const candidate = columns[columnKey];
  return is(candidate, Column) ? candidate : null;
}
