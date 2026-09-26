import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { requireReauthWindow } from '@/lib/auth/reauth/window';

import { userMsg } from './messages';

/** A rejected current password as the self-service routes answer it. */
export function asCurrentPasswordIncorrect(error: unknown): unknown {
  return error instanceof LoginRejected
    ? new CustomError(userMsg.currentPasswordIncorrect, HTTP_STATUS.BAD_REQUEST)
    : error;
}

/**
 * The caller of a contact change proves it is still them: the supplied current
 * password, or an open re-authentication window when none is supplied. Run
 * before the mutation's transaction, so no row lock is held across Argon2.
 */
export async function reauthenticateContactChange(opts: {
  userId: EntityID;
  sessionId: EntityID;
  currentPassword: string | undefined;
  auditMeta: AuditMeta;
  purpose: 'reauth_change_email' | 'reauth_change_phone';
}): Promise<void> {
  try {
    if (opts.currentPassword === undefined)
      await requireReauthWindow(opts.userId, opts.sessionId);
    else
      await verifyLoginAttempt({
        userId: opts.userId,
        password: opts.currentPassword,
        // The floor guards anonymous enumeration; this caller holds a session.
        skipTimingGuard: true,
        auditMeta: opts.auditMeta,
        purpose: opts.purpose,
      });
  } catch (error) {
    throw asCurrentPasswordIncorrect(error);
  }
}
