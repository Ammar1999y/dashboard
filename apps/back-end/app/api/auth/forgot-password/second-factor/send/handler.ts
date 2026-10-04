import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  OTP_ENABLED,
  recoverySecondFactorSendSchema,
} from '@app/shared/validation/otp';

import { resolveRecoveryOption } from '@/lib/auth/recovery/grant';
import { sendTwoFactorCode } from '@/lib/auth/two-factor/otp';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, requireFeature, withApiErrors } from '@/lib/http/response';
import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';
import { contactOf } from '@/lib/users/contact';

/**
 * ⚠️ Destination from the user row, option from the grant's issued set, so
 * nothing can redirect a code. Its own send budget, or the anonymous
 * verification surface could exhaust a locked-out user's last channel.
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
