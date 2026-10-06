/**
 * Database faults raised by PostgreSQL or the driver themselves, so the code
 * under test meets the error objects production would, not a hand-built shape.
 */
import { SQL } from 'bun';
import { spyOn } from 'bun:test';
import crypto from 'node:crypto';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { assertHarnessDatabase } from './database';

const SQLSTATE = /^[0-9A-Z]{5}$/;
const LIKE_PATTERN = /^[\w%-]+$/;

/** A real `DrizzleQueryError` whose driver cause carries `sqlstate`. */
export async function driverError(sqlstate: string): Promise<unknown> {
  if (!SQLSTATE.test(sqlstate)) throw new Error(`not a SQLSTATE: ${sqlstate}`);
  return db
    .execute(
      sql.raw(
        `do $$ begin raise exception 'harness fault' using errcode = '${sqlstate}'; end $$`
      )
    )
    .then(
      () => {
        throw new Error('the fault was not raised');
      },
      (error: unknown) => error
    );
}

/** Bun's own error for a query on a closed connection, as a reset produces. */
export async function connectionClosedError(): Promise<unknown> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set for this worker');
  const client = new SQL(url, { max: 1 });
  await client.close();
  return client`select 1`.then(
    () => {
      throw new Error('the closed client answered');
    },
    (error: unknown) => error
  );
}

/**
 * Until the returned function runs, every `operation` on a `verifications` row
 * whose identifier is LIKE `pattern` fails with `sqlstate`, raised by a
 * trigger: the statement, and the transaction around it, commit nothing.
 */
export async function failVerificationWrites(
  operation: 'insert' | 'delete',
  pattern: string,
  sqlstate: string
): Promise<() => Promise<void>> {
  if (!LIKE_PATTERN.test(pattern) || !SQLSTATE.test(sqlstate))
    throw new Error('unexpected fault pattern or SQLSTATE');
  await assertHarnessDatabase();
  const name = `harness_fault_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new.identifier like tg_argv[0] then
            raise exception 'harness fault' using errcode = tg_argv[1];
          end if;
          return new;
        end if;
        if old.identifier like tg_argv[0] then
          raise exception 'harness fault' using errcode = tg_argv[1];
        end if;
        return old;
      end $$`)
  );
  await db.execute(
    sql.raw(
      `create trigger ${name} before ${operation} on verifications for each row execute function ${name}('${pattern}', '${sqlstate}')`
    )
  );
  return async () => {
    await db.execute(sql.raw(`drop trigger ${name} on verifications`));
    await db.execute(sql.raw(`drop function ${name}()`));
  };
}

/** `failVerificationWrites` for every row of another table. */
export async function failTableWrites(
  table: string,
  operation: 'insert' | 'delete',
  sqlstate: string
): Promise<() => Promise<void>> {
  if (!/^[a-z_]+$/.test(table) || !SQLSTATE.test(sqlstate))
    throw new Error('unexpected fault table or SQLSTATE');
  await assertHarnessDatabase();
  const name = `harness_fault_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$
      begin raise exception 'harness fault' using errcode = tg_argv[0]; end $$`)
  );
  await db.execute(
    sql.raw(
      `create trigger ${name} before ${operation} on ${table} for each row execute function ${name}('${sqlstate}')`
    )
  );
  return async () => {
    await db.execute(sql.raw(`drop trigger ${name} on ${table}`));
    await db.execute(sql.raw(`drop function ${name}()`));
  };
}

/**
 * Every `db.select()` with no field list from `table` rejects with `error`
 * once awaited, whatever is chained before it. A field list, another table, or
 * a transaction's own `select` read as usual.
 */
export function failWholeRowReads(table: object, error: unknown) {
  const select = db.select.bind(db);
  const failing: object = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'then'
          ? (_resolve: unknown, reject: (reason: unknown) => void) =>
              reject(error)
          : () => failing,
    }
  );
  return spyOn(db, 'select').mockImplementation(((
    ...fields: Parameters<typeof db.select>
  ) => {
    const builder = select(...fields);
    if (fields.length > 0) return builder;
    return new Proxy(builder, {
      get: (target, key, receiver) =>
        key === 'from'
          ? (source: object) =>
              source === table ? failing : target.from(source as never)
          : Reflect.get(target, key, receiver),
    });
  }) as typeof db.select);
}
