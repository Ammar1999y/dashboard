import type {
  ExtendedColumnFilter,
  ExtendedColumnSort,
  FilterOperator,
  FilterVariant,
  JoinOperator,
} from '../types/data-table';

import { OUT_OF_RANGE, positiveInt } from '../utils';
import { dataTableConfig } from './config';

export const MAX_SORT_RAW_LENGTH = 4096;
/** Filters carry values, so they get a larger raw budget than sorts. */
export const MAX_FILTERS_RAW_LENGTH = MAX_SORT_RAW_LENGTH * 2;
/**
 * Enforced as 422s and published by `routes.ts`, so the document and the runtime
 * agree on what a client may send.
 */
export const MAX_ID_LENGTH = 64;
export const MAX_VALUE_LENGTH = 512;
export const MAX_SORT_ITEMS = 10;
export const MAX_FILTER_ITEMS = 20;
/** Values inside one filter (`inArray` selections, range tuples). */
export const MAX_FILTER_VALUES = 20;

const validOperators = new Set<string>(dataTableConfig.operators);
const VALID_JOIN_OPERATORS = new Set<string>(dataTableConfig.joinOperators);

function isFilterOperator(value: string): value is FilterOperator {
  return validOperators.has(value);
}

/** Trigram floor for quick search and the text filter operators. */
export const MIN_SEARCH_LENGTH = 3;
export const MAX_SEARCH_LENGTH = 200;

/**
 * Unicode code points, not UTF-16 code units: the floor exists to keep
 * `ILIKE '%term%'` on the trigram index, and PostgreSQL counts characters.
 * `'😀😀'.length` is 4, so `.length` clears the floor on a term for which
 * `show_trgm` returns no trigrams at all and the planner falls back to a
 * sequential scan.
 */
export function searchTermLength(term: string): number {
  return [...term].length;
}

/** Where the pattern this term becomes puts its `%`, which decides its boundaries. */
export type SearchAnchor = 'contains' | 'prefix' | 'suffix';

/**
 * pg_trgm's `ISWORDCHR`, as closely as a JavaScript class expresses it —
 * `t_isalpha || t_isdigit` under the SERVER's ctype, which is why this is an
 * approximation and not a definition.
 *
 * ⚠️ The ctype belongs to the deployment, not to this file, and the two
 * directions of a mismatch do not cost the same. A character this admits that
 * the server will NOT index is the scan an authorized user can repeat at will —
 * the whole reason the floor exists. A character this refuses that the server
 * would index only costs that search. So the class errs toward refusing:
 * `\p{Nl}` and `\p{Nd}` are in because the server indexes Roman numerals and
 * Arabic-Indic digits, `\p{No}` and the combining marks are out because it does
 * not, and `\p{Alphabetic}` is not used because it carries `Other_Alphabetic` —
 * the harakat and the circled letters, which the server treats as punctuation.
 *
 * `tests/integration/trigram-floor.test.ts` re-measures the class against
 * whichever PostgreSQL it runs on, and its admission direction is strict: a
 * ctype that indexes less than this admits fails the tier by name.
 */
const WORD_CHARACTER = /[\p{L}\p{Nl}\p{Nd}]/u;

/** Above this, `wchar_t` is too narrow for the server to classify anything. */
const BMP_MAX = 0xff_ff;

/**
 * The class, plus the one bound no property expresses.
 *
 * PostgreSQL passes each character through `char2wchar` before asking the C
 * library about it, and where `wchar_t` is 16 bits — every Windows build —
 * nothing above the BMP survives that conversion. pg_trgm therefore treats every
 * astral code point as a separator, letters and digits alike, so admitting one
 * is the scan this guard exists to refuse.
 *
 * A build with 32-bit `wchar_t` classifies them normally, and there this bound
 * costs a search in a script this application's data does not contain — the
 * cheaper of the two mistakes, which is the rule the class above follows too.
 */
function isWordCharacter(character: string): boolean {
  return (
    (character.codePointAt(0) ?? 0) <= BMP_MAX && WORD_CHARACTER.test(character)
  );
}

/**
 * Whether PostgreSQL can answer `ILIKE` over this term from the GIN trigram
 * index, which is the property `MIN_SEARCH_LENGTH` only approximates. Three
 * code points are not enough on their own: `!!!`, `---` and `😀😀😀` all
 * clear the floor and produce no trigram at all.
 *
 * pg_trgm pads each run of word characters with two leading and one trailing
 * blank, but only where the boundary is KNOWN — and a `%` is not a boundary. So
 * a run yields a trigram when it is three characters long, or one character
 * against a known left boundary (`  b`), or two against a known right one
 * (`ab `). An anchored operator supplies the missing edge: `startsWith` knows
 * its left, `endsWith` its right.
 */
export function isTrigramIndexable(
  term: string,
  anchor: SearchAnchor = 'contains'
): boolean {
  const characters = [...term];
  let runStart: number | null = null;

  for (let index = 0; index <= characters.length; index++) {
    const character = characters[index];
    if (character !== undefined && isWordCharacter(character)) {
      runStart ??= index;
      continue;
    }
    if (runStart === null) continue;

    const length = index - runStart;
    const leftKnown = runStart > 0 || anchor === 'prefix';
    const rightKnown = index < characters.length || anchor === 'suffix';
    if (
      length >= 3 ||
      (leftKnown && length >= 1) ||
      (rightKnown && length >= 2)
    )
      return true;
    runStart = null;
  }
  return false;
}

const validVariants = new Set<string>(dataTableConfig.filterVariants);

function isFilterVariant(value: string): value is FilterVariant {
  return validVariants.has(value);
}

/** Operators that are complete without a value. */
export const VALUELESS_OPERATORS: ReadonlySet<string> = new Set([
  'isEmpty',
  'isNotEmpty',
]);

const CONTROL_CHARACTERS = /\p{Cc}/gu;

export function stripControlAndTrim(value: string): string {
  return value.replaceAll(CONTROL_CHARACTERS, '').trim();
}

function safeString(v: unknown, maxLen: number): string | null {
  if (typeof v === 'string') {
    const trimmed = stripControlAndTrim(v);
    return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const str = String(v);
    return str.length <= maxLen ? str : null;
  }
  return null;
}

function toKeySet(
  columnIds: string[] | Set<string> | undefined
): Set<string> | null {
  if (!columnIds) return null;
  return columnIds instanceof Set ? columnIds : new Set(columnIds);
}

interface ParsedSortItem {
  id: string;
  desc: boolean;
}

function parseSortItem(raw: unknown): ParsedSortItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = safeString(obj.id, MAX_ID_LENGTH);
  if (!id || typeof obj.desc !== 'boolean') return null;

  return { id, desc: obj.desc };
}

/**
 * `JSON.parse` in the narrowest possible `try`, returning `null` for anything
 * that is not a JSON array.
 *
 * ⚠️ Nothing caller-supplied may run inside that `try`: the server's `onDropped`
 * throws its 422, and a wider `catch` would swallow it into an unfiltered 200.
 */
function parseJsonArray(value: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function parseSortingState<TData>(
  value: string | null | undefined,
  columnIds?: string[] | Set<string>,
  /**
   * Reports a MALFORMED or over-cap sort, for the same reason filters report
   * one. Dropping a sort is not cosmetic under pagination: it changes which
   * rows land on page one, so a request whose ordering was silently discarded
   * returns a different result set from the one that was asked for.
   *
   * An unknown column id is deliberately NOT reported — a renamed column in a
   * bookmarked URL is a compatibility case, and the caller decides that
   * separately (see `parseDataTableParams`).
   */
  onDropped?: () => void
): ExtendedColumnSort<TData>[] {
  if (!value) return [];
  if (value.length > MAX_SORT_RAW_LENGTH) {
    onDropped?.();
    return [];
  }

  const parsed = parseJsonArray(value);
  if (!parsed) {
    onDropped?.();
    return [];
  }

  const validKeys = toKeySet(columnIds);
  const items: ExtendedColumnSort<TData>[] = [];

  if (parsed.length > MAX_SORT_ITEMS) onDropped?.();

  for (const raw of parsed.slice(0, MAX_SORT_ITEMS)) {
    const item = parseSortItem(raw);
    if (!item) {
      onDropped?.();
      continue;
    }
    if (validKeys && !validKeys.has(item.id)) continue;
    items.push(item as ExtendedColumnSort<TData>);
  }

  return items;
}

export interface FilterItemSchema {
  id: string;
  value: string | string[];
  variant: FilterVariant;
  operator: FilterOperator;
  filterId: string;
}

function safeValue(v: unknown): string | null {
  return safeString(v, MAX_VALUE_LENGTH) || null;
}

/**
 * Positions are preserved, empty slots included: `isBetween` reads
 * `[lower, upper]` positionally, so compacting would turn "up to X" into
 * "from X". Operators with set semantics (`inArray`) drop the empty slots
 * themselves.
 *
 * Only `''` is a cleared slot. Any other uncoercible member (an object, an
 * over-long string, `null`) invalidates the whole filter: coerced to `''`, an
 * all-empty array reads downstream as an unexpressed filter and is skipped, so
 * malformed input would come back as an unfiltered 200.
 */
function safeArrayValue(raw: unknown[]): string[] | null {
  if (raw.length > MAX_FILTER_VALUES) return null;
  const values: string[] = [];
  for (const item of raw) {
    if (item === '') {
      values.push('');
      continue;
    }
    const value = safeValue(item);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function parseFilterItem(raw: unknown): FilterItemSchema | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = safeString(obj.id, MAX_ID_LENGTH);
  const filterId = safeString(obj.filterId, MAX_ID_LENGTH);
  if (
    !id ||
    !filterId ||
    typeof obj.variant !== 'string' ||
    !isFilterVariant(obj.variant) ||
    typeof obj.operator !== 'string' ||
    !isFilterOperator(obj.operator)
  )
    return null;

  let value: string | string[];

  if (Array.isArray(obj.value)) {
    const values = safeArrayValue(obj.value);
    if (!values) return null;
    value = values;
  } else {
    const s = safeValue(obj.value);
    // The UI submits an empty string for the valueless operators.
    if (s === null) {
      if (!VALUELESS_OPERATORS.has(obj.operator)) return null;
      value = '';
    } else {
      value = s;
    }
  }

  return {
    id,
    value,
    variant: obj.variant,
    operator: obj.operator,
    filterId,
  };
}

function parseFiltersState<TData>(
  value: string | null | undefined,
  columnIds?: string[] | Set<string>,
  /**
   * Called once per discarded item. The client leaves this unset and stays
   * lenient; the server passes a handler that rejects, because a dropped filter
   * otherwise returns an unfiltered 200. Every discard path must call it.
   */
  onDropped?: () => void
): ExtendedColumnFilter<TData>[] {
  if (!value) return [];
  if (value.length > MAX_FILTERS_RAW_LENGTH) {
    onDropped?.();
    return [];
  }

  const parsed = parseJsonArray(value);
  if (!parsed) {
    onDropped?.();
    return [];
  }

  const validKeys = toKeySet(columnIds);
  const items: ExtendedColumnFilter<TData>[] = [];

  // Reported, not silently truncated: dropping an `and` condition widens the
  // result set.
  if (parsed.length > MAX_FILTER_ITEMS) onDropped?.();

  for (const raw of parsed.slice(0, MAX_FILTER_ITEMS)) {
    const item = parseFilterItem(raw);
    if (!item) {
      onDropped?.();
      continue;
    }
    if (validKeys && !validKeys.has(item.id)) {
      onDropped?.();
      continue;
    }
    items.push(item as ExtendedColumnFilter<TData>);
  }

  return items;
}

export const MAX_PAGE = 10_000;
export const MAX_PER_PAGE = 100;
/** Page size when the caller asks for none, capped by the request's `maxPerPage`. */
export const DEFAULT_PER_PAGE = 10;

export interface GetDataSchema<T = Record<string, unknown>> {
  page: number;
  perPage: number;
  sort: ExtendedColumnSort<T>[];
  filters: ExtendedColumnFilter<T>[];
  joinOperator: JoinOperator;
  maxPerPage?: number;
}

function safeParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Every top-level key this parser reads, so the caller that owns the URL can
 * refuse the rest: a misspelled `filtres` would otherwise be a broad 200 that
 * looks filtered.
 */
export const DATA_TABLE_PARAM_KEYS = new Set([
  'maxPerPage',
  'page',
  'perPage',
  'sort',
  'filters',
  'joinOperator',
]);

export interface ParseSearchParamsOptions<T> {
  /** Applied when the request expresses no sort the allowlist accepts. */
  defaultSort?: ExtendedColumnSort<T>;
  /**
   * The sortable column ids. Without them an unsortable id still counts as a
   * sort, so `defaultSort` is skipped and the caller's allowlist later leaves
   * only the primary-key tiebreaker.
   */
  sortableColumnIds?: string[] | Set<string>;
  /**
   * Called once per discarded item. The client leaves this unset and stays
   * lenient; the server passes a handler that rejects.
   */
  onFilterDropped?: () => void;
}

export function parseSearchParams<T = Record<string, unknown>>(
  params: Record<string, string | string[] | undefined>,
  {
    defaultSort,
    sortableColumnIds,
    onFilterDropped,
  }: ParseSearchParamsOptions<T> = {}
): GetDataSchema<T> {
  // At most once per request, for a handler that counts or logs.
  let reported = false;
  const reportOnce = onFilterDropped
    ? () => {
        if (reported) return;
        reported = true;
        onFilterDropped();
      }
    : undefined;

  // Absent falls back; supplied but unreadable is reported. `positiveInt`
  // returns 0 for both, so presence is checked separately.
  const boundedInt = (
    raw: string | string[] | undefined,
    maxValue: number,
    fallback: number
  ): number => {
    const supplied = safeParam(raw);
    const parsed = positiveInt(supplied, maxValue);
    if (parsed === OUT_OF_RANGE || (supplied !== null && parsed === 0)) {
      reportOnce?.();
      return fallback;
    }
    return parsed || fallback;
  };

  const maxPerPage = boundedInt(params.maxPerPage, MAX_PER_PAGE, MAX_PER_PAGE);
  const page = boundedInt(params.page, MAX_PAGE, 1);
  const perPage = boundedInt(
    params.perPage,
    maxPerPage,
    Math.min(DEFAULT_PER_PAGE, maxPerPage)
  );

  const sort = parseSortingState<T>(
    safeParam(params.sort),
    sortableColumnIds,
    reportOnce
  );
  const filters = parseFiltersState<T>(
    safeParam(params.filters),
    undefined,
    reportOnce
  );

  // Absent means `and`; an unknown value is reported, not read as `and`.
  const joinOperatorRaw = safeParam(params.joinOperator);
  if (joinOperatorRaw !== null && !VALID_JOIN_OPERATORS.has(joinOperatorRaw))
    reportOnce?.();
  const joinOperator: JoinOperator = joinOperatorRaw === 'or' ? 'or' : 'and';

  return {
    page,
    perPage,
    sort:
      sort.length > 0
        ? sort
        : [
            defaultSort ||
              ({ id: 'createdAt', desc: true } as ExtendedColumnSort<T>),
          ],
    filters,
    joinOperator,
  };
}
