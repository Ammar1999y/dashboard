import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@app/shared/api-messages';
import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { changeEmailSchema } from '@app/shared/validation/auth';
import { EMAIL_OTP_AVAILABLE } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { otpMsg } from '@/lib/auth/messages';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  enforceOtpSurfaceSendQuota,
  enforceRateLimit,
  userIdentifier,
} from '@/lib/rate-limit';
import {
  commitEmailChange,
  refreshSessionCookies,
} from '@/lib/users/contact-change';
import { reauthenticateContactChange } from '@/lib/users/current-password';
import { userMsg } from '@/lib/users/messages';

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

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const input = await readJsonBody(ctx, changeEmailSchema);

    // Refused up front: otherwise the code goes to a dead channel or the change
    // is stranded.
    if (!OTP_AUTO_VERIFY && !EMAIL_OTP_AVAILABLE)
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    const auditMeta = getAuditMeta(ctx);
    await reauthenticateContactChange({
      userId,
      sessionId,
      currentPassword: input.currentPassword,
      auditMeta,
      purpose: 'reauth_change_email',
    });

    // A TAKEN address is not refused here: saying so before ownership is proven
    // would be an enumeration oracle. The unique index decides at commit (409);
    // only same-as-current, which reveals nothing, is refused.
    const [currentUser] = await db
      .select({
        email: users.email,
        roleId: users.roleId,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!currentUser || !currentUser.isActive)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    if (!currentUser.roleId) throw insufficientPermissions();

    const newEmail = input.newEmail;

    if (currentUser.email === newEmail)
      throw new CustomError(
        userMsg.newEmailSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

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

    await enforceOtpSurfaceSendQuota({
      channel: 'email',
      destination: newEmail,
      surface: 'contact_change',
    });
    // AWAITED, unlike the anonymous surfaces, which defer delivery to keep a
    // constant-time generic 200. This caller is authenticated and waiting for
    // the code, so `otpSent: true` must mean the provider accepted it; the
    // provider calls are bounded, so the wait is too.
    await processOtpSend({
      userId,
      identifier: newEmail,
      channel: 'email',
      purpose: 'change_email',
      targetIdentifier: newEmail,
      sendTo: newEmail,
      entityName: CONTACT_LABEL.email,
    });

    return apiSuccess({
      message: userMsg.emailChangeCodeSent,
      data: { otpSent: true },
    });
  },
  handleUserUniqueViolation
);
