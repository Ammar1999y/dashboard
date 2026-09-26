import type { AcceptedPasswordHashes } from '../login-guard';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { LoginRejected, verifyLoginAttempt } from '../login-guard';

/**
 * Proves the current password of an already-authenticated user. `null` is a
 * rejection, including a non-string `supplied`; each caller answers it in its
 * own error type.
 */
export async function verifyReauthPassword(
  userId: EntityID,
  supplied: unknown,
  auditMeta: AuditMeta
): Promise<AcceptedPasswordHashes | null> {
  if (typeof supplied !== 'string') return null;
  try {
    return await verifyLoginAttempt({
      userId,
      password: supplied,
      // The timing floor guards anonymous enumeration; this caller holds a
      // session.
      skipTimingGuard: true,
      auditMeta,
      purpose: 'reauth_two_factor',
    });
  } catch (error) {
    if (error instanceof LoginRejected) return null;
    throw error;
  }
}
