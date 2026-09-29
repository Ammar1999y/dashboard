import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { contactKindOf } from '@app/shared/validation/enums';
import {
  OTP_ENABLED,
  recoverySecondFactorSendSchema,
} from '@app/shared/validation/otp';

import { otpMsg } from '@/lib/auth/messages';
import { resolveRecoveryOption } from '@/lib/auth/recovery/grant';
import { sendTwoFactorCode } from '@/lib/auth/two-factor/otp';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature, withApiErrors } from '@/lib/http/response';
import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';
import { contactOf } from '@/lib/users/contact';

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

  const resolved = await resolveRecoveryOption(grantToken, requested);
  if (!resolved) throw invalidOrExpiredCode();
  const { grant, option } = resolved;
  if (option.method !== 'otp' || !option.channel) throw invalidOrExpiredCode();

  const [user] = await db
    .select({ email: users.email, phoneNumber: users.phoneNumber })
    .from(users)
    .where(eq(users.id, grant.userId))
    .limit(1);
  const destination = user && contactOf(user, contactKindOf(option.channel));
  if (!destination) throw invalidOrExpiredCode();

  const { nextAllowedIn } = await sendTwoFactorCode({
    userId: grant.userId,
    channel: option.channel,
    destination,
    surface: 'recovery_second_factor',
  });

  return apiSuccess({
    message: otpMsg.sendSuccess,
    data: { nextAllowedIn },
  });
});
