import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_GRANTED,
} from '@app/shared/messages/auth';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';
import { adminReauthSchema } from '@app/shared/validation/auth';

import { getAuditMeta } from '@/lib/audit';
import { verifySessionPassword } from '@/lib/auth/reauth/password';
import { enforceReauthAttemptLimit } from '@/lib/auth/reauth/session';
import { mintAdminReauth } from '@/lib/auth/reauth/window';
import { authenticationStartedAt } from '@/lib/auth/session/authentication-time';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';

export const POST = withApiErrors(MSG_UPDATE_ERROR, async (ctx) => {
  const startedAt = await authenticationStartedAt();
  const { userId, sessionId } = await requireSession(ctx);

  await enforceReauthAttemptLimit(userId);

  const input = await readJsonBody(ctx, adminReauthSchema, {
    message: MSG_INVALID_CREDENTIALS,
    status: HTTP_STATUS.UNAUTHORIZED,
  });

  const accepted = await verifySessionPassword(
    userId,
    input.password,
    getAuditMeta(ctx),
    'reauth_admin'
  );
  if (!accepted)
    throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);

  const { expiresIn } = await mintAdminReauth(userId, sessionId, {
    startedAt,
  });
  // No token in the body: the window is bound to THIS session, and a bearer
  // token would add a secret to leak and no security.
  return apiSuccess({
    message: MSG_REAUTH_GRANTED,
    data: { expiresIn },
  });
});
