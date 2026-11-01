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
import { DATA_TABLE_STATEMENT_TIMEOUT_MS, dataTableDb, db } from '@/db';
import { isStatementTimeout } from '@/db/errors';
import {
  DATA_TABLE_POOL_CONNECTIONS,
  DATABASE_RETRY_AFTER_S,
  MAX_POOL_CONNECTIONS,
} from '@/db/limits';

import { HTTP_STATUS } from '@app/shared/http-status';

import { handleApiError } from '@/lib/http/response';

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

describe('the list pool bounds what a caller-shaped statement can cost', () => {
  test('every connection carries the statement timeout and no parallel workers', async () => {
    type Settings = { timeout: string; workers: string; pid: number };
    const probe = sql`select current_setting('statement_timeout') as timeout,
      current_setting('max_parallel_workers_per_gather') as workers,
      pg_backend_pid() as pid from pg_sleep(0.1)`;
    const perConnection = await Promise.all(
      Array.from({ length: DATA_TABLE_POOL_CONNECTIONS }, () =>
        dataTableDb.execute<Settings>(probe)
      )
    );
    const rows = perConnection.flat();
    expect(new Set(rows.map((row) => row.pid)).size).toBe(
      DATA_TABLE_POOL_CONNECTIONS
    );
    for (const row of rows) {
      expect(row.timeout).toBe(`${DATA_TABLE_STATEMENT_TIMEOUT_MS / 1000}s`);
      expect(row.workers).toBe('0');
    }
  });

  test('a statement past the timeout is cancelled and answered as a retryable 503', async () => {
    const cancelled = await dataTableDb
      .execute(
        sql`select pg_sleep(${DATA_TABLE_STATEMENT_TIMEOUT_MS / 1000 + 1})`
      )
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(isStatementTimeout(cancelled)).toBe(true);
    const answer = handleApiError(cancelled);
    expect(answer.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(answer.headers?.['Retry-After']).toBe(
      String(DATABASE_RETRY_AFTER_S)
    );
  }, 15_000);
});
