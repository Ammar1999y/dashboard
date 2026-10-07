import type { FlatResendPurpose } from './throttle';
import type { HandlerInput } from '@/lib/http/contract';
import type { StartTimingFloor } from '@/lib/http/timing-floor';
import type { OtpSendSurface } from '@/lib/rate-limit';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';

import { db } from '@/db';
import { users } from '@/db/schema';

import { CONTACT_LABEL, otpMsg } from '@app/shared/messages/otp';
import { OTP_BASE_RESEND_DELAY_S } from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';
import { sendOtpSchema } from '@app/shared/validation/otp';

import { enqueueAfterResponse } from '@/lib/http/after-response';
import { readJsonBody } from '@/lib/http/input';
import { enforceOtpSurfaceSendQuota } from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

import { processOtpSend } from './send';

// Exact only because these purposes' resend delay is flat (`./throttle.ts`).
export const ANONYMOUS_SEND_DATA = { nextAllowedIn: OTP_BASE_RESEND_DELAY_S };

export interface AnonymousSendTarget {
  userId: EntityID;
  channel: OtpChannel;
  identifier: string;
}

interface AnonymousSendOptions {
  startFloor: StartTimingFloor;
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

async function settlesBefore(
  deadline: number,
  work: Promise<void>
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(
      () => resolve(false),
      Math.max(0, deadline - Date.now())
    );
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Settles identically for known and unknown identifiers; callers answer `ANONYMOUS_SEND_DATA`.
export async function sendAnonymousOtp(
  ctx: HandlerInput,
  {
    startFloor,
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

  const deadline = startFloor();
  const recipient = await findRecipient(channel, identifier);
  if (!recipient) return;

  // ⚠️ `settlesBefore` is a timer, which a synchronous wait inside `issue` would
  // hold past the deadline; nothing it awaits may block the thread.
  const issuing = (async () => {
    try {
      await issue({ userId: recipient.id, channel, identifier });
    } catch (error) {
      // A failure only a real account can reach must not answer differently
      // from a fake one, or a provider outage becomes an existence oracle.
      logSanitized('error', { msg: failureLog, error });
    }
  })();

  if (await settlesBefore(deadline, issuing)) return;
  // Locks and the pool only a real account waits on are unbounded; waiting
  // past the floor for them answers later than a fake identifier does.
  enqueueAfterResponse(ctx.rawRequest, () => issuing);
}
