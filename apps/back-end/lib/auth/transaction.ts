import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from './context';
import type { Tx } from '@/db';
import type { DrizzleAdapterConfig } from 'better-auth/adapters/drizzle';

import { db, withTransaction } from '@/db';
import * as schema from '@/db/schema';
import {
  getCurrentAdapter,
  runWithTransaction,
} from '@better-auth/core/context';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export const authAdapterOptions = {
  provider: 'pg',
  schema,
} satisfies DrizzleAdapterConfig;

const transactions = new AsyncLocalStorage<Tx>();

export const authDatabase = () => transactions.getStore() ?? db;

/**
 * The endpoint context with its adapter bound to the transaction that is open,
 * for handing to a library endpoint called from inside one.
 *
 * ⚠️ Not a convenience. `internalAdapter` resolves every statement through
 * `getCurrentAdapter`, so it already runs on the transaction — but a plugin
 * reaching for `ctx.context.adapter` DIRECTLY gets the pool, and Better Auth's
 * two-factor plugin does exactly that for its credential read and its lockout
 * counters. A pool statement issued from inside a transaction asks for a second
 * connection while holding the first, so `MAX_POOL_CONNECTIONS` concurrent
 * verifications deadlock on the pool; the same call also writes the credential
 * row the caller may hold a lock on.
 *
 * A Proxy rather than a spread: the library SETS `newSession` on this object and
 * our own after-hooks read it back off the original, so a copy would silently
 * lose every completion event.
 */
export async function transactionBoundContext(
  context: AuthContext['context']
): Promise<AuthContext['context']> {
  const adapter = await getCurrentAdapter(context.adapter);
  if (adapter === context.adapter) return context;
  return new Proxy(context, {
    get: (target, property) =>
      property === 'adapter' ? adapter : Reflect.get(target, property),
  });
}

// The session hook must read the same uncommitted identity that its adapter writes.
export async function withAuthTransaction<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return await runWithTransaction(
    {
      ...ctx.context.adapter,
      transaction: (run) =>
        withTransaction((tx) =>
          transactions.run(tx, () =>
            run(drizzleAdapter(tx, authAdapterOptions)(ctx.context.options))
          )
        ),
    },
    () => {
      const tx = transactions.getStore();
      if (!tx) throw new Error('Authentication transaction is unavailable.');
      return fn(tx);
    }
  );
}
