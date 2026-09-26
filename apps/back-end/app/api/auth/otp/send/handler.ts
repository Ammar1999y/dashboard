import type { Handler } from '@/lib/http/contract';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';
import { OTP_ENABLED, sendOtpSchema } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { ensureMinDelay, otpMsg } from '@/lib/auth/messages';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { enqueueAfterResponse } from '@/lib/http/after-response';
import { readJsonBody } from '@/lib/http/input';
import {
  apiSuccess,
  handleApiError,
  requireFeature,
} from '@/lib/http/response';
import { markContactVerified } from '@/lib/otp/contact';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import { OTP_BASE_RESEND_DELAY_S } from '@/lib/otp/throttle';
import {
  enforceOtpSurfaceSendQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { sanitizeForLog } from '@/utils/log';

// No per-identifier counters, so the fake and real paths answer the same
// shape. The resend ladder is FLAT on this surface, so the constant is exact.
const GENERIC_SEND_DATA = {
  nextAllowedIn: OTP_BASE_RESEND_DELAY_S,
};

export const POST: Handler = async (ctx) => {
  // Before any work, so the floor covers the lookup and, on the real path,
  // the send.
  const start = Date.now();
  try {
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

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk) {
      // Returned, not thrown: a captcha refusal is not privacy-sensitive, so it
      // skips the timing floor.
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );
    }

    const input = await readJsonBody(ctx, sendOtpSchema, {
      message: otpMsg.invalidInput,
    });

    const { channel } = input;
    const identifier = contactIdentifier(input);

    await enforceOtpSurfaceSendQuota({
      channel,
      destination: identifier,
      surface: 'verify_contact',
    });

    const genericResponse = () =>
      apiSuccess({
        message: otpMsg.sendSuccess,
        data: GENERIC_SEND_DATA,
      });

    const [userData] = await db
      .select({
        id: users.id,
        emailVerified: users.emailVerified,
        phoneNumberVerified: users.phoneNumberVerified,
      })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (
      !userData ||
      (channel === 'email' && userData.emailVerified) ||
      (channel !== 'email' && userData.phoneNumberVerified)
    ) {
      await ensureMinDelay(Date.now() - start);
      return genericResponse();
    }

    if (OTP_AUTO_VERIFY) {
      // Approves the contact without a code. Errors are swallowed for the same
      // reason delivery failures are below.
      try {
        await withTransaction((tx) =>
          markContactVerified(tx, {
            userId: userData.id,
            channel,
            auditMeta: getAuditMeta(ctx),
            onMissing: () => {
              // The user vanished or was deactivated mid-flow; logged apart
              // from other failures, answered with the generic message.
              console.error(
                sanitizeForLog({
                  msg: 'otp.send.autoVerify.userVanished',
                  userId: userData.id,
                  channel,
                })
              );
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );
            },
          })
        );
      } catch (error) {
        console.error(sanitizeForLog({ msg: 'otp.autoVerify.failed', error }));
      }
    } else {
      try {
        await processOtpSend({
          userId: userData.id,
          identifier,
          channel,
          purpose: 'verify_contact',
          sendTo: identifier,
          entityName: CONTACT_LABEL[contactKindOf(channel)],

          deferDelivery: (task) => enqueueAfterResponse(ctx.rawRequest, task),
        });
      } catch (error) {
        // A failure only a real account can reach must not answer differently
        // from a fake one, or a provider outage becomes an existence oracle.
        console.error(
          sanitizeForLog({ msg: 'otp.send.deliveryFailed', error })
        );
      }
    }

    await ensureMinDelay(Date.now() - start);

    return genericResponse();
  } catch (error) {
    await ensureMinDelay(Date.now() - start);

    return handleApiError(error, otpMsg.sendError);
  }
};
