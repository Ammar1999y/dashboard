import { withTransaction } from '@/db';

import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';
import { userMsg } from '@app/shared/messages/users';
import { changeEmailSchema } from '@app/shared/validation/auth';
import { EMAIL_OTP_AVAILABLE } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { refreshSessionCookies } from '@/lib/permissions/checker';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import {
  authorizeContactChange,
  commitEmailChange,
  sendContactChangeCode,
} from '@/lib/users/contact-change';

/**
 * Initiates an email change. The new address is NEVER written to `users.email`
 * here: an OTP goes to the NEW address and `POST /change-email/verify` commits
 * it once the code matches. Under OTP_AUTO_VERIFY the deployment has opted out
 * of verification, and the change commits at once.
 */
export const POST = withApiErrors(
  MSG_UPDATE_ERROR,
  async (ctx) => {
    const { userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-email.post',
      identifier: userIdentifier(userId),
      limit: 5,
      failClosed: true,
    });

    if (!(await verifyTurnstileRequest(ctx.headers))) throw captchaRefused();

    const input = await readJsonBody(ctx, changeEmailSchema);

    // Refused up front: otherwise the code goes to a dead channel or the change
    // is stranded.
    if (!OTP_AUTO_VERIFY && !EMAIL_OTP_AVAILABLE)
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    const newEmail = input.newEmail;
    const auditMeta = getAuditMeta(ctx);
    await authorizeContactChange({
      kind: 'email',
      userId,
      sessionId,
      currentPassword: input.currentPassword,
      newValue: newEmail,
      auditMeta,
    });

    if (OTP_AUTO_VERIFY) {
      await withTransaction((tx) =>
        commitEmailChange({
          tx,
          userId,
          newEmail,
          auditMeta,
        })
      );

      return apiSuccess({
        message: userMsg.emailChanged,
        data: { autoVerified: true },
        cookies: await refreshSessionCookies(ctx.headers),
      });
    }

    await sendContactChangeCode(userId, 'email', newEmail);

    return apiSuccess({
      message: userMsg.emailChangeCodeSent,
      data: { otpSent: true },
    });
  },
  handleUserUniqueViolation
);
