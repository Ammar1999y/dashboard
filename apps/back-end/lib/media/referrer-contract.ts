/**
 * Every referrer of `files` MUST have the composite `(file_id, file_status) →
 * files (id, status)` key, a status column NULL cannot slip through (`NOT NULL`,
 * or `MATCH FULL` for an optional attachment), a `file_status = 'active'` check,
 * refusing referential actions, and an entry in `USAGE_SOURCES`. That shape
 * refuses the `deleting` mark BEFORE a byte is destroyed.
 *
 * A plain `file_id → files(id)` key is invisible to `unreferenced()` and is
 * refused only at the final row delete, after the object is already gone.
 *
 * ⚠️ No runtime `@/` import: `scripts/migrate.ts` imports this by relative path
 * and runs it over its own `bun:sql` client.
 */

/** Runs one parameterless catalog statement and returns its rows. */
type CatalogQuery = (statement: string) => Promise<Record<string, unknown>[]>;

/** `table.column` for every registered `files` reference. */
type RegisteredColumns = ReadonlySet<string>;

interface ForeignKey {
  table: string;
  definition: string;
  /** `f` = MATCH FULL, `s` = MATCH SIMPLE (the default), `p` = MATCH PARTIAL. */
  matchType: string;
  /** `confupdtype`; see `REFUSING_ACTIONS`. */
  updateAction: string;
  /** `confdeltype`; same encoding. */
  deleteAction: string;
}

/**
 * `a` = NO ACTION, `r` = RESTRICT. `c`, `n` and `d` let the referenced row move
 * on and take the reference with it; see `ACTION_RULES`.
 */
const REFUSING_ACTIONS = new Set(['a', 'r']);

/**
 * ON UPDATE: SET NULL nulls both columns, and an all-null pair satisfies MATCH
 * FULL and the `CHECK`, so the `deleting` mark succeeds and silently unlinks the
 * owner. ON DELETE: the final row delete is the last refusal, reached after the
 * object is gone.
 */
const ACTION_RULES = [
  { code: 'updateAction', event: 'ON UPDATE' },
  { code: 'deleteAction', event: 'ON DELETE' },
] as const satisfies readonly {
  code: keyof ForeignKey;
  event: string;
}[];

const FOREIGN_KEYS_INTO_FILES = `
  select cl.relname as table_name,
         c.confmatchtype::text as match_type,
         c.confupdtype::text as update_action,
         c.confdeltype::text as delete_action,
         pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_class cl on cl.oid = c.conrelid
  join pg_class ref on ref.oid = c.confrelid
  where c.contype = 'f' and ref.relname = 'files'
  order by cl.relname, c.conname
`;

const NOT_NULL_COLUMNS = `
  select cl.relname as table_name, a.attname as column_name
  from pg_attribute a
  join pg_class cl on cl.oid = a.attrelid
  where a.attnotnull and a.attnum > 0 and not a.attisdropped
`;

const CHECK_CONSTRAINTS = `
  select cl.relname as table_name, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_class cl on cl.oid = c.conrelid
  where c.contype = 'c'
`;

const COMPOSITE_KEY =
  /^FOREIGN KEY \((\w+), (\w+)\) REFERENCES files\(id, status\)/;

/**
 * An exact match on PostgreSQL's printed form: a substring test also accepts a
 * check on another column whose name contains this one.
 */
function pinsToActive(definition: string, statusColumn: string): boolean {
  const normalised = definition.replaceAll(/\s+/g, '').toLowerCase();
  const column = statusColumn.toLowerCase();
  return (
    normalised === `check((${column}='active'::file_status))` ||
    normalised === `check(${column}='active'::file_status)`
  );
}

/**
 * Returns violations rather than throwing; the caller decides what is fatal.
 *
 * ⚠️ The nullability rule IS the delete protection: `MATCH SIMPLE` skips a row
 * with any NULL key component, and a `CHECK` passes NULL.
 */
export async function referrerContractViolations(
  query: CatalogQuery,
  registered: RegisteredColumns
): Promise<string[]> {
  const keyRows = await query(FOREIGN_KEYS_INTO_FILES);
  const keys: ForeignKey[] = keyRows.map((row) => ({
    table: String(row['table_name']),
    definition: String(row['definition']),
    matchType: String(row['match_type']),
    updateAction: String(row['update_action']),
    deleteAction: String(row['delete_action']),
  }));
  if (keys.length === 0) return [];

  const notNullRows = await query(NOT_NULL_COLUMNS);
  const notNull = new Set(
    notNullRows.map(
      (row) => `${String(row['table_name'])}.${String(row['column_name'])}`
    )
  );
  const checkRows = await query(CHECK_CONSTRAINTS);
  const checks = new Map<string, string[]>();
  for (const row of checkRows) {
    const table = String(row['table_name']);
    const existing = checks.get(table) ?? [];
    existing.push(String(row['definition']));
    checks.set(table, existing);
  }

  const violations: string[] = [];
  for (const key of keys) {
    const shape = COMPOSITE_KEY.exec(key.definition);
    if (!shape) {
      violations.push(
        `${key.table}: ${key.definition} is not the composite (file_id, file_status) → files (id, status) key`
      );
      continue;
    }
    const [, fileColumn = '', statusColumn = ''] = shape;
    if (key.matchType !== 'f' && !notNull.has(`${key.table}.${statusColumn}`))
      violations.push(
        `${key.table}.${statusColumn}: nullable under a MATCH SIMPLE key, so a null status skips the foreign key`
      );
    if (
      !(checks.get(key.table) ?? []).some((check) =>
        pinsToActive(check, statusColumn)
      )
    )
      violations.push(
        `${key.table}.${statusColumn}: no check fixing it to 'active'`
      );
    for (const rule of ACTION_RULES)
      if (!REFUSING_ACTIONS.has(key[rule.code]))
        violations.push(
          `${key.table}.${fileColumn}: ${rule.event} on the composite key propagates instead of refusing, so a referenced file can be released while this row still points at it`
        );
    if (!registered.has(`${key.table}.${fileColumn}`))
      violations.push(`${key.table}.${fileColumn}: not in USAGE_SOURCES`);
  }
  return violations;
}
