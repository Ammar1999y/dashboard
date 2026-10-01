import type { ReservedSQL, SavepointSQL, SQL, TransactionSQL } from 'bun';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';

import { drizzle } from 'drizzle-orm/bun-sql';

import { HTTP_STATUS, MSG_SERVICE_UNAVAILABLE } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { logLine } from '@/utils/log';

import { isStatementTimeout } from './errors';
import { DATABASE_RETRY_AFTER_S, POOL_ACQUIRE_TIMEOUT_MS } from './limits';
import * as schema from './schema';

export type Tx = Parameters<
  Parameters<BunSQLDatabase<typeof schema>['transaction']>[0]
>[0];

/**
 * A transaction given a `deadline` gave up waiting for a connection, or a
 * statement ran into it. Nothing ran, or what ran was rolled back, so the caller picks
 * the answer; the 503 below is never right for a caller that has to answer like
 * a request that waited on nothing.
 */
export class TransactionDeadlineError extends Error {
  constructor() {
    super('transaction deadline exceeded');
    this.name = 'TransactionDeadlineError';
  }
}

async function reserveWithin(
  pool: SQL,
  timeoutMs: number,
  bounded: boolean
): Promise<ReservedSQL> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await pool.reserve({ signal });
  } catch (error) {
    if (error !== signal.reason) throw error;
    logLine('error', {
      msg: 'postgres connection not acquired in time',
      causes: 'pool exhausted, or the database unreachable',
      effect: bounded
        ? 'the caller answers as its deadline requires'
        : 'this request answers 503',
      timeoutMs,
    });
    if (bounded) throw new TransactionDeadlineError();
    const unavailable = new CustomError(
      MSG_SERVICE_UNAVAILABLE,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
    unavailable.responseHeaders = {
      'Retry-After': String(DATABASE_RETRY_AFTER_S),
    };
    throw unavailable;
  }
}

/** Drizzle wraps whatever a statement threw, so the cause is read too. */
function reachedDeadline(error: unknown): boolean {
  return (
    isStatementTimeout(error) ||
    error instanceof TransactionDeadlineError ||
    (error instanceof Error && error.cause instanceof TransactionDeadlineError)
  );
}

/**
 * `target` serving `replacements` in place of its own members; everything else
 * reads through, methods bound to `target`.
 */
function withMembers<T extends object>(
  target: T,
  replacements: Record<string, unknown>
): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property === 'string' && Object.hasOwn(replacements, property))
        return replacements[property];
      const member: unknown = Reflect.get(object, property);
      return typeof member === 'function' ? member.bind(object) : member;
    },
  });
}

/**
 * `client` whose every statement first sets `statement_timeout` to the time left
 * until `deadline`, awaited so it is in force before the statement is sent.
 * PostgreSQL applies the setting to each statement afresh, so setting it once
 * would give every statement the full budget and let a transaction run for
 * their sum.
 *
 * Serves what Drizzle's Bun driver awaits (`unsafe(...)` and
 * `unsafe(...).values()`) and nothing else of a query: another use fails loudly.
 * `savepoint`, which Drizzle's nested `transaction()` calls on the raw client,
 * hands its callback a client cut the same way, at any depth.
 */
function cutAt<C extends SQL>(client: C, deadline: number): C {
  const run = async (
    query: string,
    values: Parameters<TransactionSQL['unsafe']>[1],
    rows: boolean
  ) => {
    const remainingMs = Math.ceil(deadline - Date.now());
    // `statement_timeout = 0` means no limit, hence the check.
    if (remainingMs <= 0) throw new TransactionDeadlineError();
    await client.unsafe(
      `select set_config('statement_timeout', '${remainingMs}ms', true)`
    );
    const pending = client.unsafe(query, values);
    return rows ? pending.values() : pending;
  };

  type Settled = (value: unknown) => unknown;
  type Failed = (reason: unknown) => unknown;
  return withMembers(client, {
    savepoint: (...args: unknown[]): unknown => {
      const body = args.pop();
      const savepoint: unknown = Reflect.get(client, 'savepoint');
      if (typeof body !== 'function' || typeof savepoint !== 'function')
        throw new TypeError('savepoint needs a callback and a transaction');
      return savepoint.call(client, ...args, (raw: SavepointSQL) =>
        Reflect.apply(body, undefined, [cutAt(raw, deadline)])
      );
    },
    unsafe: (
      query: string,
      values?: Parameters<TransactionSQL['unsafe']>[1]
    ) => ({
      // eslint-disable-next-line unicorn/no-thenable -- Drizzle awaits it
      then: (onFulfilled?: Settled, onRejected?: Failed) =>
        run(query, values, false).then(onFulfilled).catch(onRejected),
      values: () => ({
        // eslint-disable-next-line unicorn/no-thenable -- Drizzle awaits it
        then: (onFulfilled?: Settled, onRejected?: Failed) =>
          run(query, values, true).then(onFulfilled).catch(onRejected),
      }),
    }),
  });
}

/**
 * `withTransaction` over `pool`. The connection is reserved here rather than by
 * `db.transaction`, because `begin()` accepts no signal and would wait for a
 * free connection forever.
 *
 * `deadline` (epoch ms) replaces the acquisition bound with the time left and
 * makes it absolute for the statements too: each one is cut at the time left
 * when it starts (`cutAt`), so the transaction runs for at most `deadline` plus
 * the rollback, however many statements wait. One that reaches it throws
 * `TransactionDeadlineError` instead of answering 503. `statement_timeout`, not
 * `lock_timeout`: that restarts for each wait, and a contended row lock is two
 * (the queue for the row, then its holder), so the second waiter on a row would
 * wait twice.
 *
 * The cost is one round trip per statement. The COMMIT, and the SAVEPOINT,
 * RELEASE and ROLLBACK TO a nested transaction issues, are not cut: none waits
 * on a lock.
 */
export function transactionRunner(
  pool: SQL,
  acquireTimeoutMs = POOL_ACQUIRE_TIMEOUT_MS
) {
  return async function withTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    config?: PgTransactionConfig,
    deadline?: number
  ): Promise<T> {
    const reserved = await reserveWithin(
      pool,
      deadline === undefined
        ? acquireTimeoutMs
        : Math.max(0, deadline - Date.now()),
      deadline !== undefined
    );
    const client =
      deadline === undefined
        ? reserved
        : withMembers(reserved, {
            begin: <R>(body: (transaction: TransactionSQL) => R | Promise<R>) =>
              reserved.begin((raw) => body(cutAt(raw, deadline))),
          });
    try {
      if (deadline !== undefined && deadline <= Date.now())
        throw new TransactionDeadlineError();
      return await drizzle({ client, schema }).transaction(fn, config);
    } catch (error) {
      if (deadline !== undefined && reachedDeadline(error))
        throw new TransactionDeadlineError();
      throw error;
    } finally {
      reserved.release();
    }
  };
}
