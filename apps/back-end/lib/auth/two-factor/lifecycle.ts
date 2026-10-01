import type { AuthContext } from '../context';
import type { RequestSession } from '../session/request';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { TwoFactorMethod } from '@app/shared/validation/enums';

import { and, eq } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { passkeys } from '@/db/schema';

import { auditLog } from '@/lib/audit';

import { authAuditMeta } from '../context';
import { revokeOtherSessions } from '../session/rotation';
import { lockUser } from '../user-eligibility';
import { recordEnabledMethod } from './methods';

/** Written inside the transaction that made the change. */
export async function auditLifecycle(
  tx: Tx,
  ctx: AuthContext,
  session: RequestSession,
  newData: Record<string, unknown>
): Promise<void> {
  await auditLog(tx, {
    userId: session.userId,
    userEmail: session.userEmail,
    action: 'UPDATE',
    tableName: 'two_factor_methods',
    recordId: session.userId,
    oldData: {},
    newData: { ...newData, actor: session.userId },
    meta: authAuditMeta(ctx),
  });
}

// Evicts every other session, so an enrolment evicts an attacker already holding
// one. `./otp.ts` repeats this transition inside its proof transaction.
export async function enableMethod(
  tx: Tx,
  ctx: AuthContext,
  session: RequestSession,
  method: Exclude<TwoFactorMethod, 'otp'>,
  audit: Record<string, unknown> = {}
): Promise<void> {
  await recordEnabledMethod(tx, { userId: session.userId, method });
  await revokeOtherSessions(tx, session.userId, session.sessionId);
  await auditLifecycle(tx, ctx, session, {
    twoFactorMethodAdded: method,
    ...audit,
    twoFactorEnabled: true,
  });
}

type PasskeyEnrolmentOutcome = 'recorded' | 'no-passkey' | 'failed';

// Never throws: the plugin already persisted the credential, so the caller
// decides the registration's answer.
export async function recordPasskeyEnrolment(
  ctx: AuthContext,
  session: RequestSession,
  /** The row `/passkey/verify-registration` just wrote. */
  credentialId: EntityID
): Promise<PasskeyEnrolmentOutcome> {
  try {
    return await withTransaction<PasskeyEnrolmentOutcome>(async (tx) => {
      await lockUser(tx, session.userId);

      // ⚠️ This credential, not any: a delete can land before the lock, and an
      // older kept passkey would falsely confirm the new one.
      const owned = await tx
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(
          and(
            eq(passkeys.id, credentialId),
            eq(passkeys.userId, session.userId)
          )
        )
        .limit(1);
      if (owned.length === 0) return 'no-passkey';

      await enableMethod(tx, ctx, session, 'passkey');
      return 'recorded';
    });
  } catch {
    return 'failed';
  }
}
