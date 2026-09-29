import { withTransaction } from '@/db';

import { HTTP_STATUS, MSG_UPDATE_ERROR } from '@app/shared/api-messages';
import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { changePhoneSchema } from '@app/shared/validation/auth';
import { isChannelEnabled } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import {
  authorizeContactChange,
  commitPhoneChange,
  sendContactChangeCode,
} from '@/lib/users/contact-change';
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

    if (!(await verifyTurnstileRequest(ctx.headers))) throw captchaRefused();

    const input = await readJsonBody(ctx, changePhoneSchema);
    const { newPhoneNumber, channel } = input;

    if (!OTP_AUTO_VERIFY && !isChannelEnabled(channel))
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    const auditMeta = getAuditMeta(ctx);
    await authorizeContactChange({
      kind: 'phone',
      userId,
      sessionId,
      currentPassword: input.currentPassword,
      newValue: newPhoneNumber,
      auditMeta,
    });

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

    await sendContactChangeCode(userId, channel, newPhoneNumber);

    return apiSuccess({
      message: userMsg.phoneChangeCodeSent,
      data: { otpSent: true },
    });
  },
  handleUserUniqueViolation
);
