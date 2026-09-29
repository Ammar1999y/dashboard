import type { HandlerInput } from '@/lib/http/contract';
import type { AnonymousSendTarget } from '@/lib/otp/anonymous-send';
import type { OtpChannel } from '@app/shared/validation/enums';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';

import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { OTP_ENABLED } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { otpMsg } from '@/lib/auth/messages';
import { captchaRefused, verifyTurnstileRequest } from '@/lib/captcha';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { withTimingFloor } from '@/lib/http/timing-floor';
import {
  ANONYMOUS_SEND_DATA,
  sendAnonymousOtp,
} from '@/lib/otp/anonymous-send';
import { markContactVerified } from '@/lib/otp/contact';
import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';
import { activeUserWithContact } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

/** An already-verified contact gets nothing, answered like an unknown one. */
async function findUnverifiedRecipient(
  channel: OtpChannel,
  identifier: string
) {
  const [userData] = await db
    .select({
      id: users.id,
      emailVerified: users.emailVerified,
      phoneNumberVerified: users.phoneNumberVerified,
    })
    .from(users)
    .where(activeUserWithContact(channel, identifier))
    .limit(1);

  const verified =
    channel === 'email'
      ? userData?.emailVerified
      : userData?.phoneNumberVerified;
  return verified ? undefined : userData;
}

function autoVerifyContact(
  ctx: HandlerInput,
  { userId, channel }: AnonymousSendTarget
) {
  return withTransaction((tx) =>
    markContactVerified(tx, {
      userId,
      channel,
      auditMeta: getAuditMeta(ctx),
      onMissing: () => {
        // The user vanished or was deactivated mid-flow; logged apart from
        // other failures, answered with the generic message.
        logSanitized('error', {
          msg: 'otp.send.autoVerify.userVanished',
          userId,
          channel,
        });
        throw invalidOrExpiredCode();
      },
    })
  );
}

export const POST = withTimingFloor(otpMsg.sendError, async (ctx, floor) => {
  requireFeature(OTP_ENABLED);

  // Per IP BEFORE the captcha siteverify call: bounds that outbound request
  // and stops one IP rotating identifiers to pump delivery cost. It runs
  // before any lookup, so its 429 reveals nothing and propagates as-is.
  await enforceRateLimit({
    scope: 'otp.send.ip',
    identifier: ipIdentifier(ctx.headers),
    limit: 60,
    failClosed: true,
  });

  if (!(await verifyTurnstileRequest(ctx.headers)))
    return handleApiError(captchaRefused());

  await sendAnonymousOtp(ctx, {
    surface: 'verify_contact',
    purpose: 'verify_contact',
    failureLog: OTP_AUTO_VERIFY
      ? 'otp.autoVerify.failed'
      : 'otp.send.deliveryFailed',
    findRecipient: findUnverifiedRecipient,
    issue: OTP_AUTO_VERIFY
      ? (target) => autoVerifyContact(ctx, target)
      : undefined,
  });

  await floor();
  return apiSuccess({ message: otpMsg.sendSuccess, data: ANONYMOUS_SEND_DATA });
});
