import type { ReservedSQL } from 'bun';

import { db } from '@/db';
import { POOL_ACQUIRE_TIMEOUT_MS } from '@/db/limits';

import { logLine } from '@/utils/log';

type Election<T> = { elected: true; result: T } | { elected: false };

/**
 * Runs `run` only when no process, in this container or another, is already
 * running the job called `name`; otherwise returns `{ elected: false }`
 * without running it.
 *
 * A session-level advisory lock on one reserved connection, held for the whole
 * run: the transaction-scoped form would keep a transaction idle across the
 * job's own queries, which run on other pool connections. The wait for that
 * connection is bounded, because `reserve()` alone waits forever on a full
 * pool; `signal` abandons the wait too, never a run in progress.
 */
export async function runElected<T>(
  name: string,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<Election<T>> {
  const wait = AbortSignal.timeout(POOL_ACQUIRE_TIMEOUT_MS);
  const connection = await db.$client.reserve({
    signal: signal ? AbortSignal.any([signal, wait]) : wait,
  });
  const key = `maintenance.${name}`;
  let held = false;

  try {
    held = firstFlag(
      await connection`select pg_try_advisory_lock(hashtext(${key})) as flag`
    );
    if (!held) return { elected: false };
    return { elected: true, result: await run() };
  } finally {
    if (held) await unlock(connection, key, name);
    else connection.release();
  }
}

async function unlock(
  connection: ReservedSQL,
  key: string,
  job: string
): Promise<void> {
  const released =
    await connection`select pg_advisory_unlock(hashtext(${key})) as flag`.then(
      firstFlag,
      () => false
    );
  if (released) {
    connection.release();
    return;
  }

  // The session that held the lock ended mid-run, so another instance may
  // have run the job alongside this one.
  logLine('error', { msg: 'scheduled job lock lost', job });
  // Closed, not released: a pooled session still holding the lock would block
  // every later election of this job until that connection happened to close.
  await connection.close().catch(() => {});
}

function firstFlag(rows: unknown): boolean {
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  return (
    typeof row === 'object' &&
    row !== null &&
    'flag' in row &&
    row.flag === true
  );
}
