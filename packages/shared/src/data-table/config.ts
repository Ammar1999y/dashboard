export type DataTableConfig = typeof dataTableConfig;

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

const dataTableConfig = {
  textOperators: options<FilterOperator>([
    { label: 'يحتوي على', value: 'iLike' },
    { label: 'لا يحتوي على', value: 'notILike' },
    { label: 'يبدأ بـ', value: 'startsWith' },
    { label: 'ينتهي بـ', value: 'endsWith' },
    { label: 'يساوي', value: 'eq' },
    { label: 'لا يساوي', value: 'ne' },
    { label: 'فارغ', value: 'isEmpty' },
    { label: 'غير فارغ', value: 'isNotEmpty' },
  ]),
  numericOperators: options<FilterOperator>([
    { label: 'يساوي', value: 'eq' },
    { label: 'لا يساوي', value: 'ne' },
    { label: 'أقل من', value: 'lt' },
    { label: 'أقل من أو يساوي', value: 'lte' },
    { label: 'أكبر من', value: 'gt' },
    { label: 'أكبر من أو يساوي', value: 'gte' },
    { label: 'بين', value: 'isBetween' },
    { label: 'فارغ', value: 'isEmpty' },
    { label: 'غير فارغ', value: 'isNotEmpty' },
  ]),
  dateOperators: options<FilterOperator>([
    { label: 'يساوي', value: 'eq' },
    { label: 'لا يساوي', value: 'ne' },
    { label: 'قبل', value: 'lt' },
    { label: 'بعد', value: 'gt' },
    { label: 'يساوي أو قبل', value: 'lte' },
    { label: 'يساوي أو بعد', value: 'gte' },
    { label: 'بين', value: 'isBetween' },
    { label: 'فارغ', value: 'isEmpty' },
    { label: 'غير فارغ', value: 'isNotEmpty' },
  ]),
  selectOperators: options<FilterOperator>([
    { label: 'يساوي', value: 'eq' },
    { label: 'لا يساوي', value: 'ne' },
    { label: 'فارغ', value: 'isEmpty' },
    { label: 'غير فارغ', value: 'isNotEmpty' },
  ]),
  multiSelectOperators: options<FilterOperator>([
    { label: 'يحتوي على أي من', value: 'inArray' },
    { label: 'لا يحتوي على أي من', value: 'notInArray' },
    { label: 'فارغ', value: 'isEmpty' },
    { label: 'غير فارغ', value: 'isNotEmpty' },
  ]),
  booleanOperators: options<FilterOperator>([
    { label: 'يساوي', value: 'eq' },
    { label: 'لا يساوي', value: 'ne' },
  ]),
  // Published as `FilterOperator` although the values are `SortOrder`s; narrowing
  // it would break a consumer that relies on the published type.
  sortOrders: [
    { label: 'تصاعدي', value: 'asc' as FilterOperator },
    { label: 'تنازلي', value: 'desc' as FilterOperator },
  ],
  filterVariants,
  operators,
  joinOperators,
};

export { dataTableConfig };
