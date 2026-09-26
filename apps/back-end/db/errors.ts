import type { SQL } from 'bun';

/**
 * Drizzle wraps the driver error in a `DrizzleQueryError`, so the PostgreSQL
 * fields sit either on the thrown value or one `cause` level down. Read
 * structurally, not with `instanceof`, so this module imports no driver at
 * runtime.
 *
 * **`errno` carries the SQLSTATE, not `code`.** `Bun.SQL`'s `PostgresError`
 * puts its own identifier in `code` — `'ERR_POSTGRES_SERVER_ERROR'` for every
 * constraint violation — and the five-character SQLSTATE in `errno`, as a
 * STRING (`42P01`, `23P01`). `code` is read as well, so a SQLSTATE is still
 * recognised under the name every other PostgreSQL client uses.
 *
 * The field names are `Pick`ed from Bun's own `PostgresError` rather than
 * hand-written, so a rename or a type change there is a build failure instead
 * of a matcher that silently stops matching. Bun's spelling is not consistent
 * across its drivers: `MySQLError` carries `errno: number` AND
 * `sqlState: string`.
 */
type PgErrorFields = Pick<SQL.PostgresError, 'code' | 'errno' | 'constraint'>;
function dbErrorField<K extends keyof PgErrorFields>(
  error: unknown,
  key: K
): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return key in error ? Reflect.get(error, key) : undefined;
}

function causeOf(e: unknown): unknown {
  return e && typeof e === 'object' && 'cause' in e ? e.cause : undefined;
}

function hasSqlState(e: unknown, sqlState: string): boolean {
  const cause = causeOf(e);
  return (
    dbErrorField(e, 'errno') === sqlState ||
    dbErrorField(e, 'code') === sqlState ||
    dbErrorField(cause, 'errno') === sqlState ||
    dbErrorField(cause, 'code') === sqlState
  );
}

/** PostgreSQL `unique_violation`. */
export function isUniqueViolation(e: unknown): boolean {
  return hasSqlState(e, '23505');
}

/**
 * PostgreSQL `foreign_key_violation` — AND `restrict_violation`.
 *
 * A constraint declared `ON DELETE RESTRICT` / `ON UPDATE RESTRICT` refuses with
 * SQLSTATE `23001`, not `23503`. Several columns in `db/schema.ts` are declared
 * that way, so a caller matching only `23503` would let a restrict refusal fall
 * through to the 500 path while believing it was mapped.
 */
export function isForeignKeyViolation(e: unknown): boolean {
  return hasSqlState(e, '23503') || hasSqlState(e, '23001');
}

/**
 * PostgreSQL `character_not_in_repertoire` — a NUL byte reaching a text
 * parameter.
 *
 * The read path filters at its entry points (`@app/shared/data-table/parsers`,
 * `lib/data-table/params.ts`); this is the boundary that makes a MISSED site a
 * 422 instead of an unhandled fault whose log line embeds the SQL and its
 * parameters.
 */
export function isInvalidTextEncoding(e: unknown): boolean {
  return hasSqlState(e, '22021');
}

export function getConstraintName(e: unknown): string {
  const direct = dbErrorField(e, 'constraint');
  if (typeof direct === 'string') return direct;
  const nested = dbErrorField(causeOf(e), 'constraint');
  return typeof nested === 'string' ? nested : '';
}
