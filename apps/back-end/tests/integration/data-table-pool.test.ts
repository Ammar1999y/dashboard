/**
 * Data-table lists and PostgreSQL's prepared statements. A list's statement
 * text follows the client's filters and sorts, and on a preparing connection
 * every distinct text stays a server-side prepared statement, holding backend
 * memory, until the connection closes. Lists run on `dataTableDb`, whose pool
 * prepares nothing; these pin that, on every backend either pool holds.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { sql } from 'drizzle-orm';

import { app } from '@/app';
import { dataTableDb, db } from '@/db';
import { DATA_TABLE_POOL_CONNECTIONS, MAX_POOL_CONNECTIONS } from '@/db/limits';

import { HTTP_STATUS } from '@app/shared/http-status';

import { resetTables } from '../helpers/database';
import { authedRequest, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const state: { admin: SignedInSession | null } = { admin: null };

function admin(): SignedInSession {
  if (!state.admin) throw new Error('fixture not seeded');
  return state.admin;
}

beforeAll(async () => {
  await resetTables();
  state.admin = await signedInUser();
});

/**
 * Prepared statements summed over every backend of both pools. A statement
 * per connection, held open together, so each runs on its own backend.
 */
async function preparedStatements(): Promise<number> {
  type Backend = { n: number; pid: number };
  const probe = sql`select (select count(*) from pg_prepared_statements)::int as n,
    pg_backend_pid() as pid from pg_sleep(0.2)`;
  const reads = await Promise.all([
    ...Array.from({ length: MAX_POOL_CONNECTIONS }, () =>
      db.execute<Backend>(probe)
    ),
    ...Array.from({ length: DATA_TABLE_POOL_CONNECTIONS }, () =>
      dataTableDb.execute<Backend>(probe)
    ),
  ]);
  const perBackend = new Map(
    reads.flat().map(({ pid, n }) => [pid, n] as const)
  );
  return perBackend.values().reduce((sum, n) => sum + n, 0);
}

/** One users-list URL per `index`, each a different statement text. */
function distinctShape(index: number): string {
  const filters = Array.from({ length: 1 + (index % 20) }, (_, j) => ({
    id: 'isActive',
    value: 'true',
    variant: 'boolean',
    operator: 'eq',
    filterId: `f${j}`,
  }));
  const joinOperator = index < 20 ? 'and' : 'or';
  return `/api/dash/users?joinOperator=${joinOperator}&filters=${encodeURIComponent(JSON.stringify(filters))}`;
}

describe('data-table lists', () => {
  test('leave no prepared statement behind, however many filter shapes they serve', async () => {
    resetSqliteStores();
    const list = async (path: string) => {
      const response = await app.handle(authedRequest(admin(), path));
      expect(response.status).toBe(HTTP_STATUS.OK);
    };
    // The fixed statements every request sends are prepared by now.
    await list('/api/dash/users');
    await list('/api/dash/users');
    const before = await preparedStatements();

    const shapes = 40;
    for (let index = 0; index < shapes; index++)
      await list(distinctShape(index));

    // Each shape is two statements, its rows and its count. The slack covers
    // the fixed statements landing on a backend that had not prepared them.
    const grown = (await preparedStatements()) - before;
    expect(grown).toBeLessThan(shapes / 2);
  }, 60_000);

  test('cannot write: the jsonb column type would encode wrong unprepared', async () => {
    const write = dataTableDb.execute(
      sql`update users set name = name where false`
    );
    expect(
      await write.then(
        () => 'written',
        (error: unknown) => error
      )
    ).toMatchObject({
      cause: { errno: '25006' },
    });
  });
});
