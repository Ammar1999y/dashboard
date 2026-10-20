/**
 * `withTransaction` against an exhausted pool: a waiter fails within the
 * acquisition bound instead of queueing forever, with the typed error the
 * boundary answers 503.
 *
 * `transactionRunner` is the factory `db/index.ts` builds `withTransaction`
 * from, pointed at a one-connection pool so exhausting it takes one reserve.
 */
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { ConnectionTimeoutError } from '@/db/errors';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { transactionRunner } from '@/db/transaction';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_SERVICE_UNAVAILABLE } from '@app/shared/messages/common';

import { handleApiError } from '@/lib/http/response';

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
  test('a transaction waiting on a full pool fails within the bound, and is answered 503 and logged once', async () => {
    const held = await pool.reserve();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    let ran = false;
    const started = performance.now();
    let caught: unknown;
    try {
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

      expect(caught).toBeInstanceOf(ConnectionTimeoutError);
      expect(ran).toBe(false);
      expect(waited).toBeGreaterThanOrEqual(BOUND_MS - 20);
      expect(waited).toBeLessThan(BOUND_MS + 2000);
      expect(handleApiError(caught)).toEqual({
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        body: {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: HTTP_STATUS.SERVICE_UNAVAILABLE,
          detail: MSG_SERVICE_UNAVAILABLE,
        },
        headers: { 'Retry-After': String(DATABASE_RETRY_AFTER_S) },
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(Bun.inspect(logged.mock.calls[0])).toContain(
        'ConnectionTimeoutError'
      );
    } finally {
      logged.mockRestore();
    }
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

describe("Drizzle's relational config", () => {
  // Building it walks every schema export, which was about half of a short
  // transaction's fixed cost when it ran per transaction.
  test('is built once and shared by every transaction, with or without a deadline', async () => {
    const seen = new Set<unknown>();
    const read = (deadline?: number) =>
      withTransaction(
        async (tx) => {
          seen.add(tx._.schema);
          return tx.query.users.findFirst({ columns: { id: true } });
        },
        undefined,
        deadline
      );

    await read();
    await read();
    await read(Date.now() + 5000);
    await read(Date.now() + 5000);

    expect(seen.size).toBe(1);
    expect([...seen][0]).toBeDefined();
  });
});
