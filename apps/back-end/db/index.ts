/**
 * The PostgreSQL clients: the application's `Bun.SQL` connection pool and the
 * transaction helper that runs on it, the data-table list pool, and the
 * readiness probe's pool.
 *
 * The driver has to hold real TCP sessions: `FOR UPDATE` across statements and
 * `pg_advisory_xact_lock` both assume a transaction runs on one backend
 * connection. A per-query HTTP driver breaks them silently.
 */
import { SQL } from 'bun';
import type { Tx } from './transaction';

import { drizzle } from 'drizzle-orm/bun-sql';

import { DATABASE_URL } from '@/lib/env.server';

import { DATA_TABLE_POOL_CONNECTIONS, MAX_POOL_CONNECTIONS } from './limits';
import * as schema from './schema';
import { transactionRunner } from './transaction';

export type { Tx } from './transaction';

/**
 * Module-private on purpose: one pool of each kind per process, reachable only
 * through `db`, `dataTableDb`, `withTransaction` and `closeDatabase`, so nothing
 * can open another.
 *
 * No pool-wide `statement_timeout`, deliberately: a ceiling below a real query's duration
 * turns a slow request into a failed one, and no query here has been profiled
 * against the target host. Add one only with a measured p99 for the slowest
 * legitimate query — the data-table routes under an `allowScanOnly` filter —
 * and set it well above that. Until then a runaway query holds a connection
 * until it finishes or the client disconnects.
 * Transactions given a deadline apply a transaction-local limit per statement.
 *
 * `idle_in_transaction_session_timeout` does have a value: a request has been
 * seen to stall in Bun's driver after its row lock wait, holding that user's
 * lock until the process restarted. The timeout ends such a session and frees
 * the lock, though the stalled request itself still never answers. The longest
 * legitimate idle gap measured is a few seconds (Argon2 inside the sign-in
 * transaction under load).
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

const client = new SQL(DATABASE_URL, {
  max: MAX_POOL_CONNECTIONS,
  connection: {
    idle_in_transaction_session_timeout: String(IDLE_IN_TRANSACTION_TIMEOUT_MS),
  },
});

export const db = drizzle<typeof schema>({ client, schema });

export type Executor = typeof db | Tx;

/**
 * Keeps transaction boundaries independent of the database driver at call
 * sites, and answers 503 once no connection frees up in time.
 */
export const withTransaction = transactionRunner(client);

/**
 * A data-table list's statement text follows the client's filters and sorts,
 * and every distinct text on a preparing connection stays a server-side
 * prepared statement until the connection closes: backend memory without bound.
 * This pool prepares nothing, at the price of planning each list statement;
 * the fixed statements on `client` stay prepared, where planning would about
 * double a short lookup.
 *
 * Read-only for the session: unprepared, `bun:sql` types a parameter from its
 * JavaScript value, so the `jsonb` column type in `./schema.ts` would store an
 * object as `[object Object]`. A write here fails instead.
 */
const dataTableClient = new SQL(DATABASE_URL, {
  max: DATA_TABLE_POOL_CONNECTIONS,
  prepare: false,
  connection: { default_transaction_read_only: 'on' },
});

/** The rows and count reads of a `parseDataTableParams` list, and nothing else. */
export const dataTableDb = drizzle({ client: dataTableClient });

/**
 * The readiness probe's own pool: one connection, with the deadline enforced
 * where the work happens. Racing a query on the application pool against a
 * sleep abandons the query without stopping it, and the abandoned probe then
 * delays the auth and dashboard queries it exists to report on.
 *
 * This pool has a default `statement_timeout`; the application pool applies
 * transaction-local limits only when a caller supplies a deadline. `select 1`
 * needs no profiling.
 */
export const PROBE_TIMEOUT_MS = 2000;

const probeClient = new SQL(DATABASE_URL, {
  max: 1,
  connectionTimeout: Math.ceil(PROBE_TIMEOUT_MS / 1000),
  connection: { statement_timeout: String(PROBE_TIMEOUT_MS) },
});

/**
 * Single-flight on the QUERY, not on the caller's wait: the entry is cleared
 * only when PostgreSQL has answered or the driver has given up, so a hanging
 * peer costs one queued statement however often the public health route is
 * polled. A caller-side clear would let each poll queue another query behind
 * the abandoned one on this single connection.
 */
const probe: { inFlight: Promise<{ error: unknown } | null> | null } = {
  inFlight: null,
};

const probeTimedOut = Symbol('postgres-probe-timeout');

/**
 * True when PostgreSQL answered within `PROBE_TIMEOUT_MS`, false when it did
 * not answer in time. A refusal, an authentication or protocol error, or a
 * statement timeout is THROWN, so the caller can log its class: only the
 * response race is silent, because it says nothing about the database.
 *
 * The shared promise never rejects — it carries the failure as a value — so a
 * query that outlives every caller cannot become an unhandled rejection.
 */
export function pingDatabase(): Promise<boolean> {
  probe.inFlight ??= probeClient`select 1`
    .execute()
    .then(
      () => null,
      (error: unknown) => ({ error })
    )
    .finally(() => {
      probe.inFlight = null;
    });

  // Bounds the RESPONSE with the same constant the server-side deadline uses;
  // an unreachable host never reaches a statement, so the driver's own bounds
  // are the only thing this waits on and this race is the floor under them.
  return Promise.race([
    probe.inFlight,
    Bun.sleep(PROBE_TIMEOUT_MS).then(() => probeTimedOut),
  ]).then((raced) => {
    if (typeof raced === 'symbol') return false;
    if (raced === null) return true;
    throw raced.error;
  });
}

/**
 * ⚠️ Whether an application pool still hands out working connections, which
 * `pingDatabase` cannot see from its own pool. Bun's pool can wedge when
 * connections die while it reconnects (a PostgreSQL restart or failover):
 * every query then fails at once, for good, with a plain `Error` rather than
 * one of Bun's SQL errors, which is what a dropped connection raises while the
 * pool recovers. Only that answer counts against it: a query still waiting for
 * a busy pool is not a fault. Single-flight, so a saturated pool queues at
 * most one `select 1` however often readiness is polled.
 */
interface PoolCheck {
  pool: SQL;
  inFlight: Promise<boolean> | null;
  wedged: boolean;
}

const poolChecks: readonly PoolCheck[] = [client, dataTableClient].map(
  (pool) => ({ pool, inFlight: null, wedged: false })
);

function poolUsable(check: PoolCheck): Promise<boolean> {
  check.inFlight ??= check.pool`select 1`
    .execute()
    .then(
      () => true,
      (error: unknown) => error instanceof SQL.SQLError
    )
    .then((usable) => {
      check.wedged = !usable;
      return usable;
    })
    .finally(() => {
      check.inFlight = null;
    });
  return Promise.race([
    check.inFlight,
    Bun.sleep(PROBE_TIMEOUT_MS).then(() => true),
  ]);
}

/** `false` when either application pool has wedged. */
export async function applicationPoolUsable(): Promise<boolean> {
  const usable = await Promise.all(poolChecks.map(poolUsable));
  return usable.every(Boolean);
}

/**
 * Closes every pool on shutdown. `close()` waits for in-flight queries; the
 * shutdown path in `server.ts` is already bounded by its own forced-exit timer,
 * so this needs no timeout of its own.
 *
 * A wedged application pool is left: its `close()` never resolves, `timeout: 0`
 * included, and it has nothing left to finish, so waiting on it would only hold
 * the exit its restart needs until that timer.
 */
export async function closeDatabase(): Promise<void> {
  await Promise.all([
    ...poolChecks.map((check) =>
      check.wedged ? undefined : check.pool.close()
    ),
    probeClient.close(),
  ]);
}
