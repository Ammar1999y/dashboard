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

/**
 * Who changed what about a second factor, written INSIDE the transaction that
 * changed it. Every lifecycle transition writes one, including the OTP and
 * passkey enrolments served outside `./enrolment.ts`.
 */
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

/**
 * The transition that turns a method on: intent row, flag, and the eviction of
 * every other session — the caller's own kept, so a completed enrolment evicts
 * an attacker already holding one. `./otp.ts` performs the same transition
 * inside its proof transaction.
 */
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

/**
 * Records a registered passkey as a second factor.
 *
 * ⚠️ Never throws: the plugin has already persisted the credential when this
 * runs, so the registration's own answer is the caller's to decide. The three
 * outcomes are distinguished because they are not the same event —
 * `'no-passkey'` means the credential is gone, `'failed'` means it exists and is
 * not offered — and the caller reports each as what it is. The write is one
 * transaction, so a failure adds nothing rather than half of something.
 */
export async function recordPasskeyEnrolment(
  ctx: AuthContext,
  session: RequestSession,
  /** The row `/passkey/verify-registration` just wrote. */
  credentialId: EntityID
): Promise<PasskeyEnrolmentOutcome> {
  try {
    return await withTransaction<PasskeyEnrolmentOutcome>(async (tx) => {
      await lockUser(tx, session.userId);

      // ⚠️ THIS credential, not any credential. The plugin writes the row and
      // returns; this runs afterwards and takes the lock only now, so
      // `/passkey/delete-passkey` fits between the two. Asking whether the user
      // still holds *a* passkey answers yes for an unrelated older one —
      // `/two-factor/disable` deliberately keeps those — and the ceremony then
      // reports that the key just presented was enrolled when it is gone.
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
