import type { FilterOperator, SortOrder } from '../data-table/config';

import {
  CHARACTERS,
  CHARACTERS_OR_DIGITS,
  countOf,
  SEARCH_FILTERS,
} from './count';

export const MSG_INVALID_FILTER = 'أحد عوامل التصفية غير صالح، أعد ضبط التصفية';
export const MSG_OR_SEARCH_UNINDEXED =
  'لا يُجمع البحث في النص بـ«أو» إلا مع بحث آخر في النص، اختر «و» أو احذف التصفية الأخرى';
export const MSG_TOO_MANY_SEARCH_FILTERS = (max: number) =>
  `لا يمكن الجمع بين أكثر من ${countOf(max, SEARCH_FILTERS)} في النص، احذف إحداها`;
export const MSG_SEARCH_FILTERS_TOO_LONG = (max: number) =>
  `نصوص البحث في التصفيات معاً يجب ألا تتجاوز ${countOf(max, CHARACTERS)}، اختصر أحدها`;
export const MSG_SHORT_SEARCH = (min: number) =>
  `نص البحث في التصفية يجب أن يتضمن ${countOf(min, CHARACTERS_OR_DIGITS)} على الأقل`;

// `data-table/config` builds its option lists from these at load: keep this
// file free of runtime imports from `data-table/*`, or the two form a cycle.
export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  iLike: 'يحتوي على',
  notILike: 'لا يحتوي على',
  startsWith: 'يبدأ بـ',
  endsWith: 'ينتهي بـ',
  eq: 'يساوي',
  ne: 'لا يساوي',
  isEmpty: 'فارغ',
  isNotEmpty: 'غير فارغ',
  lt: 'أقل من',
  lte: 'أقل من أو يساوي',
  gt: 'أكبر من',
  gte: 'أكبر من أو يساوي',
  isBetween: 'بين',
  inArray: 'يحتوي على أي من',
  notInArray: 'لا يحتوي على أي من',
};

/** Where a date reads differently from a number, laid over `FILTER_OPERATOR_LABELS`. */
export const DATE_OPERATOR_LABELS: Record<
  Extract<FilterOperator, 'lt' | 'lte' | 'gt' | 'gte'>,
  string
> = {
  lt: 'قبل',
  gt: 'بعد',
  lte: 'يساوي أو قبل',
  gte: 'يساوي أو بعد',
};

export const SORT_ORDER_LABELS: Record<SortOrder, string> = {
  asc: 'تصاعدي',
  desc: 'تنازلي',
};
