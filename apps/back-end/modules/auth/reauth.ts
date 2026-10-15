import { reauthenticate } from '@app/shared/api/auth';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_GRANTED,
} from '@app/shared/messages/auth';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';

import { getAuditMeta } from '@/lib/audit';
import { verifySessionPassword } from '@/lib/auth/reauth/password';
import { REAUTH_ATTEMPT_LIMIT } from '@/lib/auth/reauth/session';
import { mintAdminReauth } from '@/lib/auth/reauth/window';
import { authenticationStartedAt } from '@/lib/auth/session/authentication-time';
import { bind } from '@/lib/http/binding';

/**
 * The gate runs the attempt limiter after the session check and before the
 * body is read, so a malformed body still spends an attempt.
 */
export const reauthenticateBinding = bind(reauthenticate, {
  rateLimit: { ...REAUTH_ATTEMPT_LIMIT, by: 'user' },
  refusals: {
    body: {
      status: HTTP_STATUS.UNAUTHORIZED,
      message: MSG_INVALID_CREDENTIALS,
    },
  },
  failure: MSG_UPDATE_ERROR,
  detail: {
    summary: 'Open the administrator re-authentication window',
    tags: ['Authentication'],
  },
  handler: async ({ body, actor: { userId, sessionId }, meta }) => {
    // Before the password is read: a credential revocation from here on
    // refuses the proof (`mintAdminReauth`).
    const startedAt = await authenticationStartedAt();

    const accepted = await verifySessionPassword(
      userId,
      body.password,
      getAuditMeta(meta),
      'reauth_admin'
    );
    if (!accepted)
      throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);

    const { expiresIn } = await mintAdminReauth(userId, sessionId, {
      startedAt,
    });
    // No token in the body: the window is bound to THIS session, and a bearer
    // token would add a secret to leak and no security.
    return { message: MSG_REAUTH_GRANTED, data: { expiresIn } };
  },
});
