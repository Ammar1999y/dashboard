import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';

import {
  isScanOnlyOperator,
  isSearchOperator,
  operatorsForSpec,
} from '@app/shared/data-table/column-specs';
import { MIN_SEARCH_LENGTH } from '@app/shared/data-table/parsers';

const codeList = (items: readonly string[]) =>
  items.map((item) => `\`${item}\``).join(', ');

/**
 * The filter contract of one descriptor map, as published prose. Derived from
 * the same map the handler passes to `parseDataTableParams`, so the documented
 * allowlist, operators and closed-set members cannot drift from the enforced
 * ones.
 */
export function describeFilterColumns(specs: FilterColumnSpecs): string {
  return Object.entries(specs)
    .map(([id, spec]) => {
      const operators = operatorsForSpec(spec);
      const indexed = operators.filter(
        (operator) =>
          isSearchOperator(operator) && !isScanOnlyOperator(operator)
      );
      const scanOnly = operators.filter(isScanOnlyOperator);
      const parts = [
        spec.type,
        ...(spec.values ? [`one of ${spec.values.join('|')}`] : []),
        ...(indexed.length > 0
          ? [
              `${codeList(indexed)} need ${MIN_SEARCH_LENGTH}+ characters once folded, including letters or digits the trigram index can key on`,
            ]
          : []),
        ...(scanOnly.length > 0
          ? [
              `${codeList(scanOnly)} needs only ${MIN_SEARCH_LENGTH}+ characters once folded`,
            ]
          : []),
        `operators: ${operators.join(', ')}`,
      ];
      return `\`${id}\` (${parts.join('; ')})`;
    })
    .join('. ');
}

/** Just the ids, for the parameters that take no operator. */
export function filterColumnIds(specs: FilterColumnSpecs): string {
  return codeList(Object.keys(specs));
}
