import type { FilterColumnSpec, FilterColumnSpecs } from './column-specs';
import type { SearchAnchor } from '@app/shared/data-table/parsers';
import type {
  ExtendedColumnFilter,
  FilterOperator,
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

import { HTTP_STATUS } from '@app/shared/api-messages';
import {
  isTrigramIndexable,
  MIN_SEARCH_LENGTH,
  searchTermLength,
} from '@app/shared/data-table/parsers';
import { CustomError } from '@app/shared/error-class';
import {
  toCalendarDate,
  zonedDayStart,
  zonedNextDayStart,
} from '@app/shared/time';

import {
  isArrayValueOperator,
  isNoValueOperator,
  isScanOnlyOperator,
  isSearchOperator,
  operatorAllowedForType,
} from './column-specs';

export const MSG_INVALID_FILTER = 'أحد عوامل التصفية غير صالح، أعد ضبط التصفية';
const MSG_SHORT_SEARCH = `نص البحث في التصفية يجب أن يتضمن ${MIN_SEARCH_LENGTH} أحرف أو أرقام على الأقل`;

/** Which edge of the `ILIKE` pattern this operator anchors — see `isTrigramIndexable`. */
function searchAnchorOf(operator: FilterOperator): SearchAnchor {
  if (operator === 'startsWith') return 'prefix';
  if (operator === 'endsWith') return 'suffix';
  return 'contains';
}

/**
 * Reject instead of silently dropping. A dropped filter broadens an `and`
 * result set and narrows an `or` one, so the caller is shown data they did not
 * ask for while receiving a 200.
 */
function invalidFilter(message = MSG_INVALID_FILTER): never {
  throw new CustomError(message, HTTP_STATUS.UNPROCESSABLE);
}

/**
 * Whether the column can actually hold an empty string, which decides whether
 * `isEmpty` may compare against `''` at all.
 *
 * `select` / `multiSelect` name a value set, not a storage type, and a closed
 * set is a PostgreSQL enum in practice: `enum_column = ''` is a cast error.
 * That leaves `text` as the only string-like type.
 */
function isStringLike(spec: FilterColumnSpec): boolean {
  return spec.type === 'text';
}

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

/** Every supplied member of a closed-set filter is one of the set's values. */
function membersAllowed(
  spec: FilterColumnSpec,
  value: unknown,
  valueIsArray: boolean
): boolean {
  if (spec.values === undefined) return true;
  const members = valueIsArray ? (value as unknown[]).filter(Boolean) : [value];
  return members.every(
    (member) => typeof member === 'string' && spec.values?.includes(member)
  );
}

/**
 * Canonical decimal only — the grammar `positiveInt` enforces on the
 * pagination bounds. Bare `Number()` accepts spellings a query string has no
 * business carrying: `Number('')` is 0, `'0x10'` is 16, `'1e2'` is 100.
 *
 * Fractions are allowed where `positiveInt` forbids them: this bounds a numeric
 * COLUMN, which may be `numeric`, not a page index.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested quantifier and no overlapping alternation; the optional fraction cannot backtrack into the integer part
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function safeNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Escape SQL LIKE/ILIKE wildcards to prevent wildcard injection */
export function escapeLike(value: string): string {
  return value.replaceAll(/[%_\\]/g, String.raw`\$&`);
}

/** Half-open UTC bounds for one calendar day in the business timezone. */
function dayBounds(raw: unknown): { start: Date; next: Date } {
  const calendarDate = toCalendarDate(raw);
  if (!calendarDate) invalidFilter();
  const start = zonedDayStart(calendarDate);
  const next = zonedNextDayStart(calendarDate);
  if (!start || !next) invalidFilter();
  return { start, next };
}

/**
 * Validate one filter against its column descriptor. Runs before any SQL is
 * built so an impossible combination becomes a 422, never a PostgreSQL cast
 * error surfacing as a 500.
 */
function assertFilterAllowed(
  filter: ExtendedColumnFilter<Table>,
  spec: FilterColumnSpec
): 'apply' | 'skip' {
  if (!operatorAllowedForType(spec.type, filter.operator)) invalidFilter();

  // Before the no-value early return: the scan-only policy is a property of
  // the OPERATOR and must hold whether or not it takes a value.
  if (isScanOnlyOperator(filter.operator) && !spec.allowScanOnly)
    invalidFilter();

  if (isNoValueOperator(filter.operator)) return 'apply';

  const valueIsArray = Array.isArray(filter.value);
  if (isArrayValueOperator(filter.operator) !== valueIsArray) invalidFilter();

  // A fixed [lower, upper] pair: a third slot is a malformed range, not one to
  // truncate.
  if (
    filter.operator === 'isBetween' &&
    (filter.value as string[]).length !== 2
  )
    invalidFilter();

  // No value chosen yet — not an invalid filter, an unexpressed one. The
  // parse layer already drops empty scalars for the same reason; treating the
  // array case differently would 422 the whole list on a half-filled chip.
  // Checked on content, not length: positional slots mean a cleared range
  // arrives as ['', ''] rather than [].
  //
  // Not the dropped-predicate case elsewhere in this file: there a real
  // condition vanished; an empty set was never a condition.
  if (valueIsArray && !(filter.value as string[]).some(Boolean)) return 'skip';

  // A member outside a closed set is a client error, not a PostgreSQL one.
  if (!membersAllowed(spec, filter.value, valueIsArray)) invalidFilter();

  if (isSearchOperator(filter.operator)) {
    if (typeof filter.value !== 'string') invalidFilter();
    const min = spec.minSearchLength ?? MIN_SEARCH_LENGTH;
    if (searchTermLength(filter.value) < min) invalidFilter(MSG_SHORT_SEARCH);
    // The floor is a proxy; this is the property. Not applied to the scan-only
    // operator, whose predicate can never use the index however the term is
    // spelled — requiring trigrams there would refuse a filter for no gain.
    if (
      !isScanOnlyOperator(filter.operator) &&
      !isTrigramIndexable(filter.value, searchAnchorOf(filter.operator))
    )
      invalidFilter(MSG_SHORT_SEARCH);
  }

  return 'apply';
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

    // The bounds are ORDERED, not taken positionally: the smaller value is the
    // start of the range whichever slot it arrived in, so a transposed pair is
    // the range the user meant rather than an unsatisfiable one. One bound alone
    // bounds its own side and leaves the other open, which is why each
    // `undefined` below is not an error.
    case 'isBetween': {
      const [rawStart, rawEnd] = value as string[];

      if (spec.type === 'date') {
        const first = rawStart ? dayBounds(rawStart) : null;
        const second = rawEnd ? dayBounds(rawEnd) : null;
        if (!first && !second) invalidFilter();
        // Compared on `start`, so an inverted pair swaps whole calendar days
        // rather than mixing one day's start with another's end.
        const ordered =
          first && second && second.start < first.start
            ? [second, first]
            : [first, second];
        return and(
          ordered[0] ? gte(column, ordered[0].start) : undefined,
          ordered[1] ? lt(column, ordered[1].next) : undefined
        );
      }

      // Absent and uncoercible must not collapse into one `null`: only absence
      // means an open side. An uncoercible bound is a 422, as it is for every
      // sibling operator; read as absent it would widen the range silently.
      const first = rawStart?.trim()
        ? (safeNumber(rawStart) ?? invalidFilter())
        : null;
      const second = rawEnd?.trim()
        ? (safeNumber(rawEnd) ?? invalidFilter())
        : null;
      if (first === null && second === null) invalidFilter();
      if (first !== null && second !== null)
        return and(
          gte(column, Math.min(first, second)),
          lte(column, Math.max(first, second))
        );
      return first === null ? lte(column, second) : gte(column, first);
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
    // `Object.hasOwn`, not `specs[id]` or `in`: the id is attacker-controlled,
    // and inherited members (`constructor`, `toString`, `__proto__`) would slip
    // past the unknown-column check and fail further down as a 500.
    // eslint-disable-next-line unicorn/no-unsafe-property-key -- guarded by Object.hasOwn
    const spec = Object.hasOwn(specs, filter.id) ? specs[filter.id] : undefined;
    if (!spec) invalidFilter();

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
