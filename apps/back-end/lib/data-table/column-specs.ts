import type { FilterColumnSpecs } from '@app/shared/data-table/column-specs';

import {
  isSearchOperator,
  operatorsForSpec,
} from '@app/shared/data-table/column-specs';

/**
 * The filter contract of one descriptor map, as published prose. Derived from
 * the same map the handler passes to `parseDataTableParams`, so the documented
 * allowlist, operators and closed-set members cannot drift from the enforced
 * ones.
 */
export function describeFilterColumns(
  specs: FilterColumnSpecs,
  defaultMinSearchLength: number
): string {
  return Object.entries(specs)
    .map(([id, spec]) => {
      const floor = spec.minSearchLength ?? defaultMinSearchLength;
      const operators = operatorsForSpec(spec);
      const parts = [
        spec.type,
        ...(spec.values ? [`one of ${spec.values.join('|')}`] : []),
        ...(operators.some(isSearchOperator)
          ? [
              `substring searches need ${floor}+ characters including letters or digits the trigram index can key on`,
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
  return Object.keys(specs)
    .map((id) => `\`${id}\``)
    .join(', ');
}
