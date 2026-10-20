import type { DataTableColumnMeta } from './column-meta';

import {
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  metaHelper,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/react-table';

/**
 * Module-level: TanStack treats a new features object as a new table. Rows
 * arrive paged, sorted and filtered, so sorting and filtering are here for
 * their column options only, with no row-model slots.
 */
export const DATA_TABLE_FEATURES = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnResizingFeature,
  columnFilteringFeature,
  rowSortingFeature,
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof DATA_TABLE_FEATURES;
