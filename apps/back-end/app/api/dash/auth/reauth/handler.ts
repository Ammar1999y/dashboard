import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_GRANTED,
  MSG_UPDATE_ERROR,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { adminReauthSchema } from '@app/shared/validation/auth';

import { getAuditMeta } from '@/lib/audit';
import { verifyReauthPassword } from '@/lib/auth/reauth/password';
import { mintAdminReauth } from '@/lib/auth/reauth/window';
import { authenticationStartedAt } from '@/lib/auth/session/authentication-time';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const POST = withApiErrors(MSG_UPDATE_ERROR, async (ctx) => {
  const startedAt = await authenticationStartedAt();
  const { userId, sessionId } = await requireSession(ctx);

  // Per user, not per IP: the budget that matters is guesses per account.
  await enforceRateLimit({
    scope: 'dash.reauth',
    identifier: userIdentifier(userId),
    limit: 10,
    failClosed: true,
  });

  const input = await readJsonBody(ctx, adminReauthSchema, {
    message: MSG_INVALID_CREDENTIALS,
    status: HTTP_STATUS.UNAUTHORIZED,
  });

  if (!(await verifyReauthPassword(userId, input.password, getAuditMeta(ctx))))
    throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);

  const { expiresIn } = await mintAdminReauth(
    userId,
    sessionId,
    'password',
    undefined,
    startedAt
  );
  // No token in the body: the window is bound to THIS session, and a bearer
  // token would add a secret to leak and no security.
  return apiSuccess({
    message: MSG_REAUTH_GRANTED,
    data: { expiresIn },
  });
});
