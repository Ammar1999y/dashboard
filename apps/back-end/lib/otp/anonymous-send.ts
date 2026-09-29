import type { FlatResendPurpose } from './throttle';
import type { HandlerInput } from '@/lib/http/contract';
import type { OtpSendSurface } from '@/lib/rate-limit';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';

import { db } from '@/db';
import { users } from '@/db/schema';

import { contactKindOf } from '@app/shared/validation/enums';
import { sendOtpSchema } from '@app/shared/validation/otp';

import { otpMsg } from '@/lib/auth/messages';
import { enqueueAfterResponse } from '@/lib/http/after-response';
import { readJsonBody } from '@/lib/http/input';
import { enforceOtpSurfaceSendQuota } from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

import { CONTACT_LABEL } from './content';
import { processOtpSend } from './send';
import { OTP_BASE_RESEND_DELAY_S } from './throttle';

/**
 * The body every anonymous send answers, real identifier or invented: no
 * per-identifier counters, so both paths return the same shape. The constant is
 * exact only because these purposes' resend ladder is flat
 * (`FLAT_RESEND_PURPOSES`, `./throttle.ts`).
 */
export const ANONYMOUS_SEND_DATA = { nextAllowedIn: OTP_BASE_RESEND_DELAY_S };

export interface AnonymousSendTarget {
  userId: EntityID;
  channel: OtpChannel;
  identifier: string;
}

interface AnonymousSendOptions {
  surface: OtpSendSurface;
  purpose: FlatResendPurpose;
  failureLog: string;
  /** Resolves `undefined` for an identifier that gets nothing. */
  findRecipient?: (
    channel: OtpChannel,
    identifier: string
  ) => Promise<{ id: EntityID } | undefined>;
  issue?: (target: AnonymousSendTarget) => Promise<unknown>;
}

async function findActiveRecipient(channel: OtpChannel, identifier: string) {
  const [userData] = await db
    .select({ id: users.id })
    .from(users)
    .where(activeUserWithContact(channel, identifier))
    .limit(1);
  return userData;
}

/**
 * The shared body of the anonymous send routes, after their own IP limiter and
 * captcha. Everything after the lookup settles the same way for a known and an
 * unknown identifier, so the caller answers `ANONYMOUS_SEND_DATA` either way.
 */
export async function sendAnonymousOtp(
  ctx: HandlerInput,
  {
    surface,
    purpose,
    failureLog,
    findRecipient = findActiveRecipient,
    issue = ({ userId, channel, identifier }) =>
      processOtpSend({
        userId,
        identifier,
        channel,
        purpose,
        sendTo: identifier,
        entityName: CONTACT_LABEL[contactKindOf(channel)],
        deferDelivery: (task) => enqueueAfterResponse(ctx.rawRequest, task),
      }),
  }: AnonymousSendOptions
): Promise<void> {
  const input = await readJsonBody(ctx, sendOtpSchema, {
    message: otpMsg.invalidInput,
  });

  const { channel } = input;
  const identifier = contactIdentifier(input);

  await enforceOtpSurfaceSendQuota({
    channel,
    destination: identifier,
    surface,
  });

  const recipient = await findRecipient(channel, identifier);
  if (!recipient) return;

  try {
    await issue({ userId: recipient.id, channel, identifier });
  } catch (error) {
    // A failure only a real account can reach must not answer differently
    // from a fake one, or a provider outage becomes an existence oracle.
    logSanitized('error', { msg: failureLog, error });
  }
}
