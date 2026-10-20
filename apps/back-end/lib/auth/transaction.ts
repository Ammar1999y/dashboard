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
 * ⚠️ `internalAdapter` already runs on the open transaction; the two-factor
 * plugin reads `ctx.context.adapter` directly, which is the pool. From inside a
 * transaction that deadlocks the pool under concurrency, and it writes the
 * credential row the caller may hold a lock on: a hang one request causes
 * alone, which `POOL_ACQUIRE_TIMEOUT_MS` does not bound.
 * A Proxy, not a spread: the library sets `newSession` on this object and our
 * after-hooks read it off the original.
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
  const adapter = ctx.context.adapter;
  const transaction: typeof adapter.transaction = (run) =>
    withTransaction((tx) =>
      transactions.run(tx, () =>
        run(drizzleAdapter(tx, authAdapterOptions)(ctx.context.options))
      )
    );
  return await runWithTransaction(
    {
      ...adapter,
      transaction,
      // The library adapter reports `transaction: false`, and for such an
      // adapter Better Auth runs the queued after-commit hooks even when the
      // work throws. This one rolls back, so its hooks must not run then.
      ...(adapter.options && {
        options: {
          ...adapter.options,
          adapterConfig: { ...adapter.options.adapterConfig, transaction },
        },
      }),
    },
    () => {
      const tx = transactions.getStore();
      if (!tx) throw new Error('Authentication transaction is unavailable.');
      return fn(tx);
    }
  );
}
