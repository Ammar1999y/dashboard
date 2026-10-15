import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';

import { MIN_SEARCH_LENGTH } from '@app/shared/data-table/parsers';

import { describeFilterColumns, filterColumnIds } from './column-specs';

/**
 * What one list route's `sort` and `filters` accept, beside their field docs
 * (`data-table/query.docs.ts`), DERIVED from the map its handler enforces.
 */
export const dataTableParameters = (
  specs: FilterColumnSpecs
): Readonly<Record<'sort' | 'filters', string>> => ({
  sort: `Allowed ids: ${filterColumnIds(specs)}.`,
  filters: `Columns: ${describeFilterColumns(specs, MIN_SEARCH_LENGTH)}.`,
});
