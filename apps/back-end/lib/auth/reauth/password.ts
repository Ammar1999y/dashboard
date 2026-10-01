import type {
  AcceptedPasswordHashes,
  PasswordProofPurpose,
} from '../login-guard';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { MSG_INVALID_CREDENTIALS } from '@app/shared/api-messages';

import { asAuthError } from '../errors';
import { LoginRejected, verifyLoginAttempt } from '../login-guard';

/** `null` for a rejected password; a lockout or a fault still throws. */
export async function verifySessionPassword(
  userId: EntityID,
  password: string,
  auditMeta: AuditMeta,
  purpose: PasswordProofPurpose
): Promise<AcceptedPasswordHashes | null> {
  try {
    return await verifyLoginAttempt({
      userId,
      password,
      // The guard hides account existence; this caller holds a session.
      skipTimingGuard: true,
      auditMeta,
      purpose,
    });
  } catch (error) {
    if (error instanceof LoginRejected) return null;
    throw error;
  }
}

// A lock throws as an `APIError`: any other throw escapes Better Auth's response.
export async function verifyReauthPassword(
  userId: EntityID,
  supplied: unknown,
  auditMeta: AuditMeta
): Promise<AcceptedPasswordHashes | null> {
  if (typeof supplied !== 'string') return null;
  try {
    return await verifySessionPassword(
      userId,
      supplied,
      auditMeta,
      'reauth_two_factor'
    );
  } catch (error) {
    throw asAuthError(error, MSG_INVALID_CREDENTIALS);
  }
}
