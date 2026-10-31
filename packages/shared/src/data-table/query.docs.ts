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
    filters: `JSON array of { id, value, variant, operator, filterId } objects, at most ${MAX_FILTER_ITEMS}; \`id\` and \`filterId\` at most ${MAX_ID_LENGTH} characters, each value at most ${MAX_VALUE_LENGTH}, and at most ${MAX_FILTER_VALUES} values in one filter. An unknown id, or an operator the column's type does not accept, is a 422. The substring operators (\`iLike\`, \`notILike\`, \`startsWith\`, \`endsWith\`) match the folded text, as \`search\` does. For \`iLike\`, \`startsWith\` and \`endsWith\`, a value whose fold in the database keys nothing (characters newer than the server's Unicode version) matches no rows; \`notILike\` matches every row that does not contain it.`,
    joinOperator:
      'How multiple structured filters are combined. With `or`, a substring filter (`iLike`, `startsWith`, `endsWith`) on a column that refuses `notILike` combines only with other such filters; any other filter beside it is a 422, because a single unindexed alternative makes the whole query a full scan.',
    search: `Quick search. Both the term and the text are folded first: case, Arabic diacritics, tatweel, Latin accents and invisible formatting characters are ignored; أ, إ, آ and ٱ match ا, ؤ matches و, ئ and ى match ي, ة matches ه; Arabic-Indic digits match ASCII ones. Terms whose folded form is outside ${MIN_SEARCH_LENGTH}–${MAX_SEARCH_LENGTH} characters, or carries no letters or digits the trigram index can key on, are ignored rather than rejected, so the response is the unfiltered list. A term that passes these checks but whose fold in the database keys nothing (characters newer than the server's Unicode version) matches no rows.`,
  }),
];
