import type { ColumnRule } from '../hooks/use-table-instance';

import { memo } from 'react';

const cssString = (value: string) =>
  value.replaceAll(/["\\\n]/g, (char) =>
    char === '\n' ? String.raw`\a ` : `\\${char}`
  );

function ruleText(
  tableId: string,
  { id, size, hidden, pinOffset }: ColumnRule
) {
  const declarations = [hidden ? 'display:none' : `width:${size}px`];
  if (pinOffset !== undefined)
    declarations.push(`--pinned-position:${pinOffset}px`);
  return `[data-table-id="${cssString(tableId)}"] [data-column="${cssString(id)}"]{${declarations.join(';')}}`;
}

interface ColumnRuleStyleProps {
  tableId: string;
  columnId: string;
  size: number;
  hidden: boolean;
  pinOffset: number | undefined;
}

const ColumnRuleStyle = memo(
  ({ tableId, columnId, size, hidden, pinOffset }: ColumnRuleStyleProps) => (
    <style>
      {ruleText(tableId, { id: columnId, size, hidden, pinOffset })}
    </style>
  )
);

ColumnRuleStyle.displayName = 'DataTableColumnRule';

// One sheet per column, not CSS variables on the table or one shared sheet:
// the browser restyles every element under a changed custom property, and
// every element a rewritten sheet's selectors match, so only a per-column
// sheet confines a resize step, or a hide, to that column's cells.
/** Width, visibility and pin offset of every column, for `cellAttributes`. */
function ColumnRules({
  tableId,
  rules,
}: {
  tableId: string;
  rules: ColumnRule[];
}) {
  return rules.map((rule) => (
    <ColumnRuleStyle
      key={rule.id}
      tableId={tableId}
      columnId={rule.id}
      size={rule.size}
      hidden={rule.hidden}
      pinOffset={rule.pinOffset}
    />
  ));
}

export { ColumnRules };
