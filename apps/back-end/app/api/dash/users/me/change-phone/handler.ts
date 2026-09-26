import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@app/shared/api-messages';
import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { changePhoneSchema } from '@app/shared/validation/auth';
import { isChannelEnabled } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { otpMsg } from '@/lib/auth/messages';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import { insufficientPermissions } from '@/lib/permissions/checker';
import {
  enforceOtpSurfaceSendQuota,
  enforceRateLimit,
  userIdentifier,
} from '@/lib/rate-limit';
import { commitPhoneChange } from '@/lib/users/contact-change';
import { reauthenticateContactChange } from '@/lib/users/current-password';
import { userMsg } from '@/lib/users/messages';

/**
 * Initiates a phone-number change; like email, the new number is written only
 * once ownership is proven by OTP, or at once under OTP_AUTO_VERIFY.
 */
export const POST = withApiErrors(
  MSG_UPDATE_ERROR,
  async (ctx) => {
    requireFeature(PHONE_ENABLED);

    const { userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-phone.post',
      identifier: userIdentifier(userId),
      limit: 5,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const input = await readJsonBody(ctx, changePhoneSchema);
    const { newPhoneNumber, channel } = input;

    if (!OTP_AUTO_VERIFY && !isChannelEnabled(channel))
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
      purpose: 'reauth_change_phone',
    });

    const [currentUser] = await db
      .select({
        phoneNumber: users.phoneNumber,
        roleId: users.roleId,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!currentUser || !currentUser.isActive)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    if (!currentUser.roleId) throw insufficientPermissions();
    // A taken number is not refused here, for the reason `change-email` gives.
    if (currentUser.phoneNumber === newPhoneNumber)
      throw new CustomError(
        userMsg.newPhoneSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    if (OTP_AUTO_VERIFY) {
      await withTransaction((tx) =>
        commitPhoneChange({
          tx,
          userId,
          newPhoneNumber,
          keepSessionId: sessionId,
          auditMeta,
        })
      );

      return apiSuccess({
        message: userMsg.phoneChanged,
        data: { autoVerified: true },
      });
    }

    // `sms` and `whatsapp` share one per-destination budget, so switching
    // transport does not double the paid messages one number can be sent.
    await enforceOtpSurfaceSendQuota({
      channel,
      destination: newPhoneNumber,
      surface: 'contact_change',
    });
    await processOtpSend({
      userId,
      identifier: newPhoneNumber,
      channel,
      purpose: 'change_phone',
      targetIdentifier: newPhoneNumber,
      sendTo: newPhoneNumber,
      entityName: CONTACT_LABEL.phone,
    });

    return apiSuccess({
      message: userMsg.phoneChangeCodeSent,
      data: { otpSent: true },
    });
  },
  handleUserUniqueViolation
);
