import { MSG_UPDATE_ERROR } from '@app/shared/api-messages';
import { changeEmailVerifySchema } from '@app/shared/validation/auth';

import { getAuditMeta } from '@/lib/audit';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { verifyOtpOrAutoVerify } from '@/lib/otp/verify';
import { refreshSessionCookies } from '@/lib/permissions/checker';
import {
  enforceOtpVerifyQuota,
  enforceRateLimit,
  userIdentifier,
} from '@/lib/rate-limit';
import { commitEmailChange } from '@/lib/users/contact-change';
import { userMsg } from '@/lib/users/messages';

/**
 * Step 2 of the email change: the code sent to the NEW address is verified
 * and, in the SAME transaction, the address committed and all the user's
 * sessions revoked, so there is no verify→commit replay window.
 */
export const POST = withApiErrors(
  MSG_UPDATE_ERROR,
  async (ctx) => {
    const { session, userId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-email.verify.post',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    if (!(await verifyTurnstileRequest(ctx.headers))) throw captchaRefused();

    const input = await readJsonBody(ctx, changeEmailVerifySchema);

    const newEmail = input.newEmail;
    const auditMeta = getAuditMeta(ctx);

    await enforceOtpVerifyQuota({
      channel: 'email',
      identifier: newEmail,
      surface: 'contact_change',
    });

    // OTP_AUTO_VERIFY commits directly, idempotent if the initiate step already
    // did. Otherwise the proof is looked up by (user, contact kind, purpose,
    // identifier), so a code can only commit the address it was issued for.
    await verifyOtpOrAutoVerify({
      userId,
      userEmail: session.user.email,
      channel: 'email',
      purpose: 'change_email',
      identifier: newEmail,
      code: input.code,
      auditMeta,
      // The address bound to the proven session, not the request body.
      onVerified: (tx, matched) =>
        commitEmailChange({
          tx,
          userId,
          newEmail: matched?.targetIdentifier ?? newEmail,
          keepVerificationSessionId: matched?.verificationSessionId,
          auditMeta,
        }),
    });

    return apiSuccess({
      message: userMsg.emailChanged,
      data: { verified: true },
      cookies: await refreshSessionCookies(ctx.headers),
    });
  },
  handleUserUniqueViolation
);
