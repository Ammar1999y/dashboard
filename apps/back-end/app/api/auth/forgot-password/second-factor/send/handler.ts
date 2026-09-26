import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  OTP_ENABLED,
  recoverySecondFactorSendSchema,
} from '@app/shared/validation/otp';

import { otpMsg } from '@/lib/auth/messages';
import { readRecoveryGrant } from '@/lib/auth/recovery/grant';
import {
  readEnrolmentState,
  recoveryOptions,
} from '@/lib/auth/two-factor/methods';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature, withApiErrors } from '@/lib/http/response';
import { CONTACT_LABEL } from '@/lib/otp/content';
import { processOtpSend } from '@/lib/otp/send';
import {
  enforceOtpSurfaceSendQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';

/**
 * Sends the second-factor code for a recovery grant.
 *
 * ⚠️ The destination comes from the USER ROW and the option must be one the
 * grant issued, so nothing here redirects a code: not to the contact the
 * recovery code arrived on, not to a contact the account does not hold.
 *
 * Its own send budget (`recovery_second_factor`): a shared one would let the
 * anonymous contact-verification surface exhaust the only channel a locked-out
 * user has left.
 */
export const POST = withApiErrors(otpMsg.sendError, async (ctx) => {
  requireFeature(OTP_ENABLED);

  await enforceRateLimit({
    scope: 'forgot.second-factor.send.ip',
    identifier: ipIdentifier(ctx.headers),
    limit: 30,
    failClosed: true,
  });

  const { grant: grantToken, option: requested } = await readJsonBody(
    ctx,
    recoverySecondFactorSendSchema,
    { message: otpMsg.invalidInput }
  );

  const grant = await readRecoveryGrant(grantToken);
  if (!grant)
    throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

  // The issued set narrowed by CURRENT capability: an enrolment gone since the
  // grant was minted is no option, and one that appeared is none either.
  const state = await readEnrolmentState(grant.userId);
  const issued = new Set(grant.options);
  const option = recoveryOptions(state, grant.excludeContactKind).find(
    (entry) =>
      issued.has(entry.id) && entry.method === 'otp' && entry.id === requested
  );
  if (!option?.channel)
    throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

  const [user] = await db
    .select({ email: users.email, phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, grant.userId))
    .limit(1);
  const destination =
    option.contactKind === 'email' ? user?.email : user?.phoneNumber;
  if (!destination)
    throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

  await enforceOtpSurfaceSendQuota({
    channel: option.channel,
    destination,
    surface: 'recovery_second_factor',
  });

  const { nextAllowedIn } = await processOtpSend({
    userId: grant.userId,
    identifier: destination,
    channel: option.channel,
    purpose: 'two_factor',
    sendTo: destination,
    entityName:
      CONTACT_LABEL[option.contactKind === 'email' ? 'email' : 'phone'],
  });

  return apiSuccess({
    message: otpMsg.sendSuccess,
    data: { nextAllowedIn },
  });
});
