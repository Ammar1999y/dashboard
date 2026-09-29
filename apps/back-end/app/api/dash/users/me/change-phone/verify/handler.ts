import { MSG_UPDATE_ERROR } from '@app/shared/api-messages';
import { PHONE_ENABLED } from '@app/shared/config';
import { changePhoneVerifySchema } from '@app/shared/validation/auth';

import { getAuditMeta } from '@/lib/audit';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature, withApiErrors } from '@/lib/http/response';
import { requireSession } from '@/lib/http/session';
import { verifyOtpOrAutoVerify } from '@/lib/otp/verify';
import {
  enforceOtpVerifyQuota,
  enforceRateLimit,
  userIdentifier,
} from '@/lib/rate-limit';
import { commitPhoneChange } from '@/lib/users/contact-change';
import { userMsg } from '@/lib/users/messages';

/**
 * Step 2 of the phone change: the code sent to the NEW number is verified and
 * the number committed in the same transaction, so there is no replay window.
 */
export const POST = withApiErrors(
  MSG_UPDATE_ERROR,
  async (ctx) => {
    requireFeature(PHONE_ENABLED);

    const { session, userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-phone.verify.post',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    if (!(await verifyTurnstileRequest(ctx.headers))) throw captchaRefused();

    const input = await readJsonBody(ctx, changePhoneVerifySchema);

    const { newPhoneNumber, channel } = input;
    const auditMeta = getAuditMeta(ctx);

    await enforceOtpVerifyQuota({
      channel,
      identifier: newPhoneNumber,
      surface: 'contact_change',
    });

    await verifyOtpOrAutoVerify({
      userId,
      userEmail: session.user.email,
      channel,
      purpose: 'change_phone',
      identifier: newPhoneNumber,
      code: input.code,
      auditMeta,
      // The number bound to the proven session, not the request body.
      onVerified: (tx, matched) =>
        commitPhoneChange({
          tx,
          userId,
          newPhoneNumber: matched?.targetIdentifier ?? newPhoneNumber,
          keepSessionId: sessionId,
          keepVerificationSessionId: matched?.verificationSessionId,
          auditMeta,
        }),
    });

    return apiSuccess({
      message: userMsg.phoneChanged,
      data: { verified: true },
    });
  },
  handleUserUniqueViolation
);
