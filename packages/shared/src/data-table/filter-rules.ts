import type { FilterOperator, JoinOperator } from '../types/data-table';
import type { FilterColumnSpec, FilterColumnSpecs } from './column-specs';
import type { FilterItemSchema, SearchAnchor } from './parsers';

import { CustomError } from '../error-class';
import { HTTP_STATUS } from '../http-status';
import {
  MSG_INVALID_FILTER,
  MSG_OR_SEARCH_UNINDEXED,
  MSG_SEARCH_FILTERS_TOO_LONG,
  MSG_SHORT_SEARCH,
  MSG_TOO_MANY_SEARCH_FILTERS,
} from '../messages/data-table';
import { searchFold } from '../search-fold';
import { toCalendarDate, zonedDayStart, zonedNextDayStart } from '../time';
import {
  isArrayValueOperator,
  isNoValueOperator,
  isScanOnlyOperator,
  isSearchOperator,
  operatorAllowedForType,
} from './column-specs';
import {
  cleanSearchTerm,
  DATA_TABLE_PARAMS,
  isTrigramIndexable,
  MAX_SEARCH_FILTERS,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  searchTermLength,
} from './parsers';

/** What the parser reads, and `search`, which is read beside it. */
const ACCEPTED_PARAM_KEYS: ReadonlySet<string> = new Set(
  Object.values(DATA_TABLE_PARAMS)
);

/** Which edge of the `ILIKE` pattern this operator anchors — see `isTrigramIndexable`. */
export function searchAnchorOf(operator: FilterOperator): SearchAnchor {
  if (operator === 'startsWith') return 'prefix';
  if (operator === 'endsWith') return 'suffix';
  return 'contains';
}

/**
 * Reject instead of silently dropping. A dropped filter broadens an `and`
 * result set and narrows an `or` one, so the caller is shown data they did not
 * ask for while receiving a 200.
 */
export function invalidFilter(message = MSG_INVALID_FILTER): never {
  throw new CustomError(message, HTTP_STATUS.UNPROCESSABLE);
}

/**
 * Unknown as well as repeated: an ignored `serach=` would answer an
 * unfiltered 200 that the caller reads as a search result.
 */
export function assertDataTableParamKeys(searchParams: URLSearchParams): void {
  const seen = new Set<string>();
  for (const key of searchParams.keys()) {
    if (seen.has(key) || !ACCEPTED_PARAM_KEYS.has(key)) invalidFilter();
    seen.add(key);
  }
}

/** The descriptor of a filterable column; an id without one is a 422. */
export function requireFilterSpec(
  specs: FilterColumnSpecs,
  id: string
): FilterColumnSpec {
  // `Object.hasOwn`, not `specs[id]` or `in`: the id is attacker-controlled,
  // and inherited members (`constructor`, `toString`, `__proto__`) would slip
  // past the unknown-column check and fail further down as a 500.
  const spec = Object.hasOwn(specs, id) ? specs[id] : undefined;
  if (!spec) invalidFilter();
  return spec;
}

/**
 * Whether the column can actually hold an empty string, which decides whether
 * `isEmpty` may compare against `''` at all.
 *
 * `select` / `multiSelect` name a value set, not a storage type, and a closed
 * set is a PostgreSQL enum in practice: `enum_column = ''` is a cast error.
 * That leaves `text` as the only string-like type.
 */
export function isStringLike(spec: Pick<FilterColumnSpec, 'type'>): boolean {
  return spec.type === 'text';
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

export function safeNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Half-open UTC bounds for one calendar day in the business timezone. */
export function dayBounds(raw: unknown): { start: Date; next: Date } {
  const calendarDate = toCalendarDate(raw);
  if (!calendarDate) invalidFilter();
  const start = zonedDayStart(calendarDate);
  const next = zonedNextDayStart(calendarDate);
  if (!start || !next) invalidFilter();
  return { start, next };
}

// The `isBetween` bounds are ORDERED, not taken positionally: the smaller value
// is the start of the range whichever slot it arrived in, so a transposed pair
// is the range the user meant rather than an unsatisfiable one. One bound alone
// bounds its own side and leaves the other open, which is why each `null` the
// two functions below return is not an error.

/** Inclusive numeric bounds of an `isBetween` value. */
export function numberRangeBounds(value: readonly string[]): {
  lower: number | null;
  upper: number | null;
} {
  const [rawStart, rawEnd] = value;
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
    return { lower: Math.min(first, second), upper: Math.max(first, second) };
  return { lower: first, upper: second };
}

/** Half-open instant bounds (`>= start`, `< next`) of a date `isBetween` value. */
export function dayRangeBounds(value: readonly string[]): {
  start: Date | null;
  next: Date | null;
} {
  const [rawStart, rawEnd] = value;
  const first = rawStart ? dayBounds(rawStart) : null;
  const second = rawEnd ? dayBounds(rawEnd) : null;
  if (!first && !second) invalidFilter();
  // Compared on `start`, so an inverted pair swaps whole calendar days rather
  // than mixing one day's start with another's end.
  const [lower, upper] =
    first && second && second.start < first.start
      ? [second, first]
      : [first, second];
  return { start: lower?.start ?? null, next: upper?.next ?? null };
}

/**
 * Validate one filter against its column descriptor. Runs before any SQL is
 * built so an impossible combination becomes a 422, never a PostgreSQL cast
 * error surfacing as a 500.
 */
export function assertFilterAllowed(
  filter: FilterItemSchema,
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

  // No value chosen yet — not an invalid filter, an unexpressed one. Unlike an
  // empty scalar, which the parse layer discards and the server then refuses,
  // a cleared range is skipped so a half-filled chip doesn't 422 the list.
  // Checked on content, not length: positional slots mean a cleared range
  // arrives as ['', ''] rather than [].
  //
  // Not the dropped-predicate case the condition builders refuse: there a
  // real condition vanished; an empty set was never a condition.
  if (valueIsArray && !(filter.value as string[]).some(Boolean)) return 'skip';

  // A member outside a closed set is a client error, not a PostgreSQL one.
  if (!membersAllowed(spec, filter.value, valueIsArray)) invalidFilter();

  if (isSearchOperator(filter.operator)) {
    if (typeof filter.value !== 'string') invalidFilter();
    // Measured on the fold, as quick search is: it is the text the index holds.
    const term = searchFold(filter.value);
    if (searchTermLength(term) < MIN_SEARCH_LENGTH)
      invalidFilter(MSG_SHORT_SEARCH(MIN_SEARCH_LENGTH));
    // The floor is a proxy; this is the property. Not applied to the scan-only
    // operator, whose predicate can never use the index however the term is
    // spelled — requiring trigrams there would refuse a filter for no gain.
    if (
      !isScanOnlyOperator(filter.operator) &&
      !isTrigramIndexable(term, searchAnchorOf(filter.operator))
    )
      invalidFilter(MSG_SHORT_SEARCH(MIN_SEARCH_LENGTH));
  }

  return 'apply';
}

/**
 * Why the search filters of one request are refused together, or `undefined`.
 * Counted on the fold, as each one is matched. A filter whose fold is empty
 * counts nothing: it is no condition yet, and `assertFilterAllowed` refuses it
 * on its own.
 */
export function searchBudgetRefusal(
  filters: readonly FilterItemSchema[]
): string | undefined {
  let count = 0;
  let characters = 0;
  for (const { operator, value } of filters) {
    if (typeof value !== 'string' || !isSearchOperator(operator)) continue;
    // Cleaned as the parser cleans it, so a draft measures what will be sent.
    const length = searchTermLength(searchFold(cleanSearchTerm(value)));
    if (length === 0) continue;
    count += 1;
    characters += length;
  }
  if (count > MAX_SEARCH_FILTERS)
    return MSG_TOO_MANY_SEARCH_FILTERS(MAX_SEARCH_FILTERS);
  if (characters > MAX_SEARCH_LENGTH)
    return MSG_SEARCH_FILTERS_TOO_LONG(MAX_SEARCH_LENGTH);
  return undefined;
}

/**
 * ⚠️ One disjunct no index serves turns the whole OR into a sequential scan
 * that folds every row once per search term: the full scan `allowScanOnly`
 * keeps off a column, reached without its scan-only operator.
 */
function isUnindexedOr(
  admitted: readonly { filter: FilterItemSchema; spec: FilterColumnSpec }[]
): boolean {
  let guardedSearch = false;
  let unindexed = false;
  for (const { filter, spec } of admitted) {
    const indexedSearch =
      isSearchOperator(filter.operator) && !isScanOnlyOperator(filter.operator);
    if (indexedSearch && !spec.allowScanOnly) guardedSearch = true;
    if (!indexedSearch) unindexed = true;
  }
  return guardedSearch && unindexed;
}

/**
 * The filters one list request applies, each with its descriptor: every rule
 * a single filter must meet (`assertFilterAllowed`), then the rules over the
 * whole list. Throws the 422 of the first rule broken.
 */
export function admitFilters<F extends FilterItemSchema>(
  filters: readonly F[],
  specs: FilterColumnSpecs,
  joinOperator: JoinOperator
): { filter: F; spec: FilterColumnSpec }[] {
  const admitted: { filter: F; spec: FilterColumnSpec }[] = [];
  for (const filter of filters) {
    const spec = requireFilterSpec(specs, filter.id);
    if (assertFilterAllowed(filter, spec) === 'skip') continue;
    admitted.push({ filter, spec });
  }

  const overBudget = searchBudgetRefusal(admitted.map(({ filter }) => filter));
  if (overBudget) invalidFilter(overBudget);
  if (joinOperator === 'or' && isUnindexedOr(admitted))
    invalidFilter(MSG_OR_SEARCH_UNINDEXED);

  return admitted;
}
