/**
 * `withTransaction` against an exhausted pool: a waiter fails with the mapped
 * 503 within the acquisition bound instead of queueing forever.
 *
 * `transactionRunner` is the factory `db/index.ts` builds `withTransaction`
 * from, pointed at a one-connection pool so exhausting it takes one reserve.
 */
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { transactionRunner } from '@/db/transaction';

import { HTTP_STATUS, MSG_SERVICE_UNAVAILABLE } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { assertHarnessDatabase } from '../helpers/database';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set for this worker');
const BOUND_MS = 300;
const pool = new SQL(url, { max: 1 });
const withTransaction = transactionRunner(pool, BOUND_MS);

beforeAll(async () => {
  await assertHarnessDatabase();
});

afterAll(async () => {
  await pool.close();
});

describe('pool acquisition bound', () => {
  test('a transaction waiting on a full pool answers 503 within the bound', async () => {
    const held = await pool.reserve();
    let ran = false;
    const started = performance.now();
    let caught: unknown;
    try {
      await withTransaction(async () => {
        ran = true;
      });
    } catch (error) {
      caught = error;
    } finally {
      held.release();
    }
    const waited = performance.now() - started;

    expect(caught).toBeInstanceOf(CustomError);
    expect({
      status: (caught as CustomError).status,
      message: (caught as CustomError).message,
      ran,
    }).toEqual({
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: MSG_SERVICE_UNAVAILABLE,
      ran: false,
    });
    expect(waited).toBeGreaterThanOrEqual(BOUND_MS - 20);
    expect(waited).toBeLessThan(BOUND_MS + 2000);
  });

  test('the timed-out waiter took nothing: the pool serves the next transaction on one backend', async () => {
    const pids = await withTransaction(async (tx) => {
      const [first] = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`
      );
      const [second] = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`
      );
      return [first?.pid, second?.pid];
    });
    expect(pids[0]).toBeNumber();
    expect(pids[1]).toBe(pids[0]);

    const [outside] = await pool`select 1 as one`;
    expect(outside).toEqual({ one: 1 });
  });

  test('a connection freed while waiting is taken, and a throw rolls back and releases it', async () => {
    const held = await pool.reserve();
    setTimeout(() => held.release(), BOUND_MS / 3);
    expect(await withTransaction(async () => 'served')).toBe('served');

    await expect(
      withTransaction(async (tx) => {
        await tx.execute(sql`create temporary table pool_probe (n int)`);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const [probe] =
      await pool`select to_regclass('pg_temp.pool_probe') is null as gone`;
    expect(probe).toEqual({ gone: true });
  });
});
