import type { FilterVariant } from '@app/shared/types/data-table';

// The table's own column options on TanStack's `columnDef.meta`, typed through
// the `columnMeta` slot in `features.ts`. The data shapes the server shares —
// sorts, filters, operators, page meta — come from `@app/shared/types` and are
// never redeclared here.
export interface DataTableColumnMeta {
  label?: string;
  placeholder?: string;
  variant?: FilterVariant;
  options?: { label: string; value: string; count?: number }[];
  range?: [number, number];
  /** `false` keeps the column out of drag and menu reordering. */
  enableOrdering?: boolean;
}
