import type { ReservedSQL, SavepointSQL, SQL, TransactionSQL } from 'bun';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';

import { drizzle } from 'drizzle-orm/bun-sql';

import { ConnectionTimeoutError, isStatementTimeout } from './errors';
import { POOL_ACQUIRE_TIMEOUT_MS } from './limits';
import * as schema from './schema';

export type Tx = Parameters<
  Parameters<BunSQLDatabase<typeof schema>['transaction']>[0]
>[0];

/**
 * A transaction given a `deadline` gave up waiting for a connection, or ran
 * into it. Nothing ran, or what ran was rolled back, so the caller picks the
 * answer; the 503 a `ConnectionTimeoutError` gets is never right for a caller
 * that has to answer like a request that waited on nothing.
 */
export class TransactionDeadlineError extends Error {
  constructor(options?: ErrorOptions) {
    super('transaction deadline exceeded', options);
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
    const timedOut = new ConnectionTimeoutError(timeoutMs);
    throw bounded
      ? new TransactionDeadlineError({ cause: timedOut })
      : timedOut;
  }
}

/** The first cut a deadline made in one transaction, at any depth. */
interface Cut {
  error: TransactionDeadlineError | null;
}

/** The deadline error `error` is or wraps; Drizzle wraps whatever a statement threw. */
function deadlineErrorOf(error: unknown): TransactionDeadlineError | null {
  if (error instanceof TransactionDeadlineError) return error;
  if (error instanceof Error && error.cause instanceof TransactionDeadlineError)
    return error.cause;
  return isStatementTimeout(error)
    ? new TransactionDeadlineError({ cause: error })
    : null;
}

/**
 * `target` answering with `members` alone. Any other member, or a
 * tagged-template call, throws: it would run a statement the deadline does not
 * reach. Symbols read through, for inspection.
 */
function servedOnly<T extends object>(
  target: T,
  members: Record<string, unknown>
): T {
  return new Proxy(target, {
    get(object, property) {
      if (typeof property !== 'string') return Reflect.get(object, property);
      if (Object.hasOwn(members, property)) return members[property];
      throw new TypeError(
        `\`${property}\` is not served on a transaction with a deadline`
      );
    },
    apply() {
      throw new TypeError(
        'a tagged-template query is not served on a transaction with a deadline'
      );
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
 * Serves what Drizzle's Bun driver calls on a transaction: `unsafe(...)`
 * awaited, `unsafe(...).values()`, and `savepoint`, whose callback gets a
 * client cut the same way, at any depth. `servedOnly` refuses the rest.
 */
function cutAt<C extends SQL>(client: C, deadline: number, cut: Cut): C {
  const run = async (
    query: string,
    values: Parameters<TransactionSQL['unsafe']>[1],
    rows: boolean
  ) => {
    const remainingMs = Math.ceil(deadline - Date.now());
    // `statement_timeout = 0` means no limit, hence the check.
    if (remainingMs <= 0) throw (cut.error ??= new TransactionDeadlineError());
    try {
      await client.unsafe(
        `select set_config('statement_timeout', '${remainingMs}ms', true)`
      );
      const pending = client.unsafe(query, values);
      return await (rows ? pending.values() : pending);
    } catch (error) {
      if (isStatementTimeout(error))
        cut.error ??= new TransactionDeadlineError({ cause: error });
      throw error;
    }
  };

  type Settled = (value: unknown) => unknown;
  type Failed = (reason: unknown) => unknown;
  return servedOnly(client, {
    savepoint: (...args: unknown[]): unknown => {
      const body = args.pop();
      const savepoint: unknown = Reflect.get(client, 'savepoint');
      if (typeof body !== 'function' || typeof savepoint !== 'function')
        throw new TypeError('savepoint needs a callback and a transaction');
      return savepoint.call(client, ...args, (raw: SavepointSQL) =>
        Reflect.apply(body, undefined, [cutAt(raw, deadline, cut)])
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
 * Runs `fn` on `reserved` so that nothing it does commits after `deadline`:
 * every statement is cut at the time left, and the COMMIT is refused when a cut
 * happened, even one `fn` caught, or when work after its last statement ran
 * past the deadline. Once cut, the answer is the deadline's, whatever `fn` threw
 * after.
 */
async function runWithinDeadline<T>(
  reserved: ReservedSQL,
  deadline: number,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  const cut: Cut = { error: null };
  const client = servedOnly(reserved, {
    begin: <R>(body: (transaction: TransactionSQL) => R | Promise<R>) =>
      reserved.begin((raw) => body(cutAt(raw, deadline, cut))),
  });
  try {
    if (deadline <= Date.now()) throw new TransactionDeadlineError();
    return await drizzle({ client, schema }).transaction(async (tx) => {
      const result = await fn(tx);
      if (cut.error) throw cut.error;
      if (deadline <= Date.now()) throw new TransactionDeadlineError();
      return result;
    });
  } catch (error) {
    throw deadlineErrorOf(error) ?? cut.error ?? error;
  }
}

/**
 * `withTransaction` over `pool`. The connection is reserved here rather than by
 * `db.transaction`, because `begin()` accepts no signal and would wait for a
 * free connection forever; no connection in time throws
 * `ConnectionTimeoutError`, which the error boundaries answer 503.
 *
 * `deadline` (epoch ms) replaces the acquisition bound with the time left and
 * holds the whole transaction to it (`runWithinDeadline`): past it, nothing is
 * committed and `TransactionDeadlineError` is thrown, after at most the
 * rollback. `statement_timeout`, not `lock_timeout`: that restarts for each
 * wait, and a contended row lock is two (the queue for the row, then its
 * holder), so the second waiter on a row would wait twice.
 *
 * The cost is one round trip per statement. The SAVEPOINT, RELEASE, ROLLBACK
 * TO and COMMIT the driver sends are not cut separately: none waits on a lock,
 * and each runs under the limit the last statement set.
 */
export function transactionRunner(
  pool: SQL,
  acquireTimeoutMs = POOL_ACQUIRE_TIMEOUT_MS
) {
  function withTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    config?: PgTransactionConfig
  ): Promise<T>;
  // No `config` with a deadline: the time left is set by the first statement,
  // and PostgreSQL refuses a transaction's characteristics after one.
  function withTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    config: undefined,
    deadline: number | undefined
  ): Promise<T>;
  async function withTransaction<T>(
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
    try {
      return deadline === undefined
        ? await drizzle({ client: reserved, schema }).transaction(fn, config)
        : await runWithinDeadline(reserved, deadline, fn);
    } finally {
      reserved.release();
    }
  }
  return withTransaction;
}
