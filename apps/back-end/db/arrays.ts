import type { AnyColumn, SQL } from 'drizzle-orm';

import { sql } from 'drizzle-orm';

type ListColumn = AnyColumn<{
  columnType: 'PgUUID' | 'PgText' | 'PgVarchar';
  data: string;
}>;

/**
 * `any(…)` over ONE bound array, in place of `inArray`'s `in ($1, $2, …)`,
 * which makes every distinct list length its own statement: the pool prepares
 * each one per connection, crowding out the fixed statements sign-in reuses,
 * and PostgreSQL refuses one past 65,535 parameters. `sql.param` keeps the
 * array one value: a bare array in a `sql` template expands to `(a, b)`.
 *
 * `text`, never `varchar(n)`: that cast truncates, so a longer value would
 * match a stored prefix.
 */
const anyOf = (values: readonly string[], element: 'uuid' | 'text'): SQL =>
  sql`any(${sql.param(values)}::${sql.raw(element)}[])`;

/** For `x = any(…)` in a raw statement. */
export const anyUuid = (ids: readonly string[]): SQL => anyOf(ids, 'uuid');

/** `inArray(column, values)`, an empty list matching nothing alike. */
export function inList<C extends ListColumn>(
  column: C,
  values: readonly C['_']['data'][]
): SQL {
  return sql`${column} = ${anyOf(values, column.columnType === 'PgUUID' ? 'uuid' : 'text')}`;
}
