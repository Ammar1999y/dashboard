/**
 * A list bound as one array (`db/arrays.ts`) is one prepared statement whatever
 * its length. Measured on the server: each case runs in one transaction, so
 * every read of `pg_prepared_statements` is the same backend's.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Tx } from '@/db';

import { sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { inList } from '@/db/arrays';
import { files, users } from '@/db/schema';

import { governedIds } from '@/lib/media/files';
import { userNames } from '@/lib/users/names';

import { resetTables } from '../helpers/database';
import { seedUser } from '../helpers/session';

const uuids = (length: number) =>
  Array.from({ length }, () => crypto.randomUUID());

async function preparedStatements(tx: Tx): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_prepared_statements`
  );
  if (!row) throw new Error('count(*) answered no row');
  return row.n;
}

// Lengths nothing else plausibly prepared on this backend: under a list per
// length, each would add a statement.
const LENGTHS = [37, 38, 39, 40, 41];

const QUERIES: [string, (tx: Tx, length: number) => Promise<unknown>][] = [
  ['userNames', (tx, length) => userNames(uuids(length), tx)],
  ['governedIds', (tx, length) => governedIds(tx, uuids(length))],
  [
    'a text column',
    (tx, length) =>
      tx
        .select({ id: files.id })
        .from(files)
        .where(inList(files.r2Key, uuids(length))),
  ],
];

beforeAll(resetTables);

describe('inList', () => {
  test.each(QUERIES)(
    '%s prepares one statement for every list length',
    async (_, run) => {
      await withTransaction(async (tx) => {
        await run(tx, 1);
        await preparedStatements(tx);
        const before = await preparedStatements(tx);
        for (const length of LENGTHS) await run(tx, length);
        expect(await preparedStatements(tx)).toBe(before);
      });
    }
  );

  test('matches what inArray does, and nothing for an empty list', async () => {
    const user = await seedUser();
    const byId = (ids: string[]) =>
      db.select({ id: users.id }).from(users).where(inList(users.id, ids));
    const byEmail = (emails: string[]) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(inList(users.email, emails));

    expect(await byId([user.userId, crypto.randomUUID()])).toEqual([
      { id: user.userId },
    ]);
    expect(await byEmail([user.email, 'absent@example.com'])).toEqual([
      { id: user.userId },
    ]);
    expect(await byId([])).toEqual([]);
    expect(await byEmail([])).toEqual([]);
  });
});
