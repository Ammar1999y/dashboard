import type { HandlerRequestMeta } from '@/lib/http/contract';
import type { AnonymousSendTarget } from '@/lib/otp/anonymous-send';
import type { OtpChannel } from '@app/shared/validation/enums';

import { db, withTransaction } from '@/db';
import { users } from '@/db/schema';

import { sendOtp, verifyOtp } from '@app/shared/api/auth';
import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_ENABLED } from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { bind } from '@/lib/http/binding';
import {
  ANONYMOUS_SEND_DATA,
  sendAnonymousOtp,
} from '@/lib/otp/anonymous-send';
import { markContactVerified } from '@/lib/otp/contact';
import { invalidOrExpiredCode } from '@/lib/otp/throttle';
import { verifyOtpOrAutoVerify } from '@/lib/otp/verify';
import { enforceOtpVerifyQuota } from '@/lib/rate-limit';
import { activeUserWithContact, contactIdentifier } from '@/lib/users/contact';

import { logSanitized } from '@/utils/log';

import {
  COLLAPSED_BODY_REFUSALS,
  collapsedVerifyError,
  FIXED_BODY_REFUSAL,
  PUBLISHED_SEND_BODY,
} from './anonymous';

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
  meta: Pick<HandlerRequestMeta, 'ip' | 'userAgent' | 'apiPath'>,
  { userId, channel }: AnonymousSendTarget
) {
  return withTransaction((tx) =>
    markContactVerified(tx, {
      userId,
      channel,
      auditMeta: getAuditMeta(meta),
      onMissing: () => {
        // User vanished mid-flow: logged apart, answered generically.
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

// No pre-auth limit on either: their per-identifier and per-destination
// budgets are tighter than the coarse per-IP one.
export const sendOtpBinding = bind(sendOtp, {
  enabled: OTP_ENABLED,
  preAuthIpLimit: false,
  // The gate runs it before the captcha, bounding siteverify and identifier
  // rotation; pre-lookup, so its 429 reveals nothing.
  rateLimit: { scope: 'otp.send.ip', limit: 60, failClosed: true, by: 'ip' },
  timingFloor: true,
  refusals: FIXED_BODY_REFUSAL,
  failure: otpMsg.sendError,
  detail: {
    summary: 'Send a one-time code',
    tags: ['Authentication'],
    publishedBody: PUBLISHED_SEND_BODY,
  },
  handler: async ({ body: input, meta }) => {
    await sendAnonymousOtp(input, meta.rawRequest, {
      startFloor: meta.startFloor,
      surface: 'verify_contact',
      purpose: 'verify_contact',
      failureLog: OTP_AUTO_VERIFY
        ? 'otp.autoVerify.failed'
        : 'otp.send.deliveryFailed',
      findRecipient: findUnverifiedRecipient,
      issue: OTP_AUTO_VERIFY
        ? (target) => autoVerifyContact(meta, target)
        : undefined,
    });

    return { message: otpMsg.sendSuccess, data: ANONYMOUS_SEND_DATA };
  },
});

export const verifyOtpBinding = bind(verifyOtp, {
  enabled: OTP_ENABLED,
  preAuthIpLimit: false,
  // Before the captcha, bounding siteverify and code spraying across identifiers.
  rateLimit: { scope: 'otp.verify.ip', limit: 60, failClosed: true, by: 'ip' },
  timingFloor: true,
  refusals: COLLAPSED_BODY_REFUSALS,
  failure: otpMsg.verifyError,
  mapError: collapsedVerifyError(),
  detail: { summary: 'Verify a one-time code', tags: ['Authentication'] },
  handler: async ({ body: input, meta }) => {
    const { channel, code } = input;
    const identifier = contactIdentifier(input);

    await enforceOtpVerifyQuota({
      channel,
      identifier,
      surface: 'verify_contact',
    });

    const deadline = meta.startFloor();
    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(activeUserWithContact(channel, identifier))
      .limit(1);

    if (!userData) throw invalidOrExpiredCode();

    const auditMeta = getAuditMeta(meta);

    const onMissing = (): never => {
      // User vanished mid-flow: logged apart, answered generically.
      logSanitized('error', {
        msg: 'otp.verify.userVanished',
        userId: userData.id,
        channel,
      });
      throw invalidOrExpiredCode();
    };

    // Under OTP_AUTO_VERIFY a client that still calls verify succeeds idempotently.
    await verifyOtpOrAutoVerify({
      userId: userData.id,
      userEmail: userData.email,
      channel,
      purpose: 'verify_contact',
      identifier,
      code,
      auditMeta,
      deadline,
      onVerified: (tx) =>
        markContactVerified(tx, {
          userId: userData.id,
          channel,
          auditMeta,
          onMissing,
        }),
    });

    return {
      message: otpMsg.verifySuccess(channel),
      data: { verified: true as const },
    };
  },
});
