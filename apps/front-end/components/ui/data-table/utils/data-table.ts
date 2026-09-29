import type {
  FilterOperator,
  FilterVariant,
} from '@app/shared/types/data-table';

import { dataTableConfig } from '@app/shared/data-table/config';

const OPERATORS: Record<
  FilterVariant,
  { label: string; value: FilterOperator }[]
> = {
  text: dataTableConfig.textOperators,
  number: dataTableConfig.numericOperators,
  range: dataTableConfig.numericOperators,
  date: dataTableConfig.dateOperators,
  boolean: dataTableConfig.booleanOperators,
  select: dataTableConfig.selectOperators,
  multiSelect: dataTableConfig.multiSelectOperators,
};

export function getFilterOperators(filterVariant: FilterVariant) {
  return OPERATORS[filterVariant] ?? dataTableConfig.textOperators;
}

export function getDefaultFilterOperator(filterVariant: FilterVariant) {
  const operators = getFilterOperators(filterVariant);

  return operators[0]?.value ?? (filterVariant === 'text' ? 'iLike' : 'eq');
}
