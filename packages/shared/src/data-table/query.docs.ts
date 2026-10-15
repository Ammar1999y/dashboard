import { fieldDocs } from '../api/field-docs';
import {
  DEFAULT_PER_PAGE,
  MAX_FILTER_ITEMS,
  MAX_FILTER_VALUES,
  MAX_ID_LENGTH,
  MAX_PAGE,
  MAX_PER_PAGE,
  MAX_SEARCH_LENGTH,
  MAX_SORT_ITEMS,
  MAX_VALUE_LENGTH,
  MIN_SEARCH_LENGTH,
} from './parsers';
import { dataTableQuerySchema } from './query';

/** Each list route adds the ids and columns it accepts (`detail.parameters`). */
export const docs = [
  fieldDocs(dataTableQuerySchema, {
    maxPerPage: `Upper bound applied to perPage for this request, 1 to ${MAX_PER_PAGE}. Lowering it below the default (${DEFAULT_PER_PAGE}) also lowers the page size used when perPage is omitted.`,
    page: `One-based page number, at most ${MAX_PAGE}.`,
    perPage: `Rows per page, 1 to ${MAX_PER_PAGE}, defaulting to ${DEFAULT_PER_PAGE}. A \`maxPerPage\` on the same request lowers this ceiling; a value above the effective ceiling is rejected, not clamped.`,
    sort: `JSON array of { id, desc } objects, at most ${MAX_SORT_ITEMS}, each id at most ${MAX_ID_LENGTH} characters. An id outside the route's list is ignored and the route's default sort applies.`,
    filters: `JSON array of { id, value, variant, operator, filterId } objects, at most ${MAX_FILTER_ITEMS}; \`id\` and \`filterId\` at most ${MAX_ID_LENGTH} characters, each value at most ${MAX_VALUE_LENGTH}, and at most ${MAX_FILTER_VALUES} values in one filter. An unknown id, or an operator the column's type does not accept, is a 422.`,
    joinOperator: 'How multiple structured filters are combined.',
    search: `Quick search. Terms outside ${MIN_SEARCH_LENGTH}–${MAX_SEARCH_LENGTH} characters, and terms carrying no letters or digits the trigram index can key on, are ignored rather than rejected, so the response is the unfiltered list.`,
  }),
];
