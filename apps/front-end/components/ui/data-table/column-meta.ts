import type { FilterVariant } from '@app/shared/types/data-table';
import type { RowData } from '@tanstack/react-table';

// The table's own column options on TanStack's `columnDef.meta`, registered
// for every consumer by the import in `index.ts`. The data shapes the server
// shares — sorts, filters, operators, page meta — come from
// `@app/shared/types` and are never redeclared here.
declare module '@tanstack/react-table' {
  // The augmentation must repeat TanStack's type parameters, used or not.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
    placeholder?: string;
    variant?: FilterVariant;
    options?: { label: string; value: string; count?: number }[];
    range?: [number, number];
    /** `false` keeps the column out of drag and menu reordering. */
    enableOrdering?: boolean;
  }
}

export {};
