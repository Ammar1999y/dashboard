import {
  DATE_OPERATOR_LABELS,
  FILTER_OPERATOR_LABELS,
  SORT_ORDER_LABELS,
} from '../messages/data-table';

const operators = [
  'iLike',
  'notILike',
  'eq',
  'ne',
  'inArray',
  'notInArray',
  'isEmpty',
  'isNotEmpty',
  'lt',
  'lte',
  'gt',
  'gte',
  'isBetween',
  'startsWith',
  'endsWith',
] as const;

const joinOperators = ['and', 'or'] as const;
const filterVariants = [
  'text',
  'number',
  'range',
  'date',
  'boolean',
  'select',
  'multiSelect',
] as const;

export type FilterOperator = (typeof operators)[number];
/** @knipignore */
export type JoinOperator = (typeof joinOperators)[number];
/** @knipignore */
export type FilterVariant = (typeof filterVariants)[number];
export type SortOrder = 'asc' | 'desc';

interface Option<T extends string> {
  label: string;
  value: T;
}

const options = <T extends string>(entries: Option<T>[]) => entries;

const operatorOptions = (
  values: readonly FilterOperator[],
  labels: Record<FilterOperator, string> = FILTER_OPERATOR_LABELS
) =>
  options<FilterOperator>(
    values.map((value) => ({ label: labels[value], value }))
  );

const DATE_LABELS = { ...FILTER_OPERATOR_LABELS, ...DATE_OPERATOR_LABELS };

const dataTableConfig = {
  textOperators: operatorOptions([
    'iLike',
    'notILike',
    'startsWith',
    'endsWith',
    'eq',
    'ne',
    'isEmpty',
    'isNotEmpty',
  ]),
  numericOperators: operatorOptions([
    'eq',
    'ne',
    'lt',
    'lte',
    'gt',
    'gte',
    'isBetween',
    'isEmpty',
    'isNotEmpty',
  ]),
  dateOperators: operatorOptions(
    [
      'eq',
      'ne',
      'lt',
      'gt',
      'lte',
      'gte',
      'isBetween',
      'isEmpty',
      'isNotEmpty',
    ],
    DATE_LABELS
  ),
  selectOperators: operatorOptions(['eq', 'ne', 'isEmpty', 'isNotEmpty']),
  multiSelectOperators: operatorOptions([
    'inArray',
    'notInArray',
    'isEmpty',
    'isNotEmpty',
  ]),
  booleanOperators: operatorOptions(['eq', 'ne']),
  sortOrders: options<SortOrder>([
    { label: SORT_ORDER_LABELS.asc, value: 'asc' },
    { label: SORT_ORDER_LABELS.desc, value: 'desc' },
  ]),
  filterVariants,
  operators,
  joinOperators,
};

export { dataTableConfig };
