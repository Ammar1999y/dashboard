/**
 * `withAuthTransaction` runs on a real database transaction, so the hooks
 * queued inside it (a session's `create.after` audit row, `delete.after`
 * artifact revocation) must run only when it commits. Better Auth runs them
 * after a failure too for an adapter that reports `transaction: false`.
 */
import { describe, expect, test } from 'bun:test';
import type { AuthContext } from '@/lib/auth/context';

import { queueAfterTransactionHook } from '@better-auth/core/context';

import { auth } from '@/lib/auth';
import { withAuthTransaction } from '@/lib/auth/transaction';

async function run(fail: boolean) {
  let ran = false;
  // `withAuthTransaction` reads only `context`; the instance's own context is
  // typed with this deployment's options, the endpoint's with the generic ones.
  const ctx = { context: await auth.$context } as unknown as AuthContext;
  const outcome = await withAuthTransaction(ctx, async () => {
    await queueAfterTransactionHook(async () => {
      ran = true;
    });
    if (fail) throw new Error('rolled back');
    return 'committed';
  }).catch((error: unknown) =>
    error instanceof Error ? error.message : 'unknown'
  );
  return { outcome, ran };
}

describe('hooks queued in an auth transaction', () => {
  test('run once it commits', async () => {
    expect(await run(false)).toEqual({ outcome: 'committed', ran: true });
  });

  test('do not run when it rolls back', async () => {
    expect(await run(true)).toEqual({ outcome: 'rolled back', ran: false });
  });
});
