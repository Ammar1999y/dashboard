import type { RouteDefinition } from '@/lib/http/route-manifest';
import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';

import { dataTableConfig } from '@app/shared/data-table/config';
import {
  DEFAULT_PER_PAGE,
  MAX_FILTER_ITEMS,
  MAX_FILTER_VALUES,
  MAX_FILTERS_RAW_LENGTH,
  MAX_ID_LENGTH,
  MAX_PAGE,
  MAX_PER_PAGE,
  MAX_SEARCH_LENGTH,
  MAX_SORT_ITEMS,
  MAX_SORT_RAW_LENGTH,
  MAX_VALUE_LENGTH,
  MIN_SEARCH_LENGTH,
} from '@app/shared/data-table/parsers';

import { describeFilterColumns, filterColumnIds } from './column-specs';

/**
 * The list-query parameters for one route, DERIVED from the descriptor map the
 * handler enforces: `specs` is the object passed to `parseDataTableParams`, so
 * the document and the runtime cannot disagree.
 */
export const dataTableQuery = (
  specs: FilterColumnSpecs
): NonNullable<RouteDefinition['query']> => [
  {
    name: 'maxPerPage',
    required: false,
    description: `Upper bound applied to perPage for this request. Lowering it below the default (${DEFAULT_PER_PAGE}) also lowers the page size used when perPage is omitted.`,
    type: 'integer',
    minimum: 1,
    maximum: MAX_PER_PAGE,
  },
  {
    name: 'page',
    required: false,
    description: 'One-based page number.',
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE,
  },
  {
    name: 'perPage',
    required: false,
    // A dependency between two parameters, which no OpenAPI keyword expresses.
    description: `Rows per page, defaulting to ${DEFAULT_PER_PAGE}. A \`maxPerPage\` on the same request lowers this ceiling; a value above the effective ceiling is rejected, not clamped.`,
    type: 'integer',
    minimum: 1,
    maximum: MAX_PER_PAGE,
  },
  {
    name: 'sort',
    required: false,
    description: `JSON array of { id, desc } objects, at most ${MAX_SORT_ITEMS}, each id at most ${MAX_ID_LENGTH} characters. An id outside the list below is ignored and the route's default sort applies. Allowed ids: ${filterColumnIds(specs)}.`,
    maxLength: MAX_SORT_RAW_LENGTH,
    example: '[{"id":"createdAt","desc":true}]',
  },
  {
    name: 'filters',
    required: false,
    description: `JSON array of { id, value, variant, operator, filterId } objects, at most ${MAX_FILTER_ITEMS}; \`id\` and \`filterId\` at most ${MAX_ID_LENGTH} characters, each value at most ${MAX_VALUE_LENGTH}, and at most ${MAX_FILTER_VALUES} values in one filter. An unknown id, or an operator the column's type does not accept, is a 422. Columns: ${describeFilterColumns(specs, MIN_SEARCH_LENGTH)}.`,
    maxLength: MAX_FILTERS_RAW_LENGTH,
  },
  {
    name: 'joinOperator',
    required: false,
    description: 'How multiple structured filters are combined.',
    enum: [...dataTableConfig.joinOperators],
  },
  // No `maxLength`, unlike the parameters above: this is the one the parser
  // ignores rather than rejects, and a bound the server does not enforce makes
  // a generated client refuse a request this API accepts.
  {
    name: 'search',
    required: false,
    description: `Quick search. Terms outside ${MIN_SEARCH_LENGTH}–${MAX_SEARCH_LENGTH} characters, and terms carrying no letters or digits the trigram index can key on, are ignored rather than rejected, so the response is the unfiltered list.`,
  },
];
