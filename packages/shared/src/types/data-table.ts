import type { FilterItemSchema } from '../data-table/parsers';

export type {
  FilterOperator,
  FilterVariant,
  JoinOperator,
} from '../data-table/config';

export interface ExtendedColumnSort<TData> {
  id: Extract<keyof TData, string>;
  desc: boolean;
}

export interface ExtendedColumnFilter<TData> extends FilterItemSchema {
  id: Extract<keyof TData, string>;
}
