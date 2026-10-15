import { withTransaction } from '@/db';

import {
  changeEmail,
  changePhone,
  verifyEmailChange,
  verifyPhoneChange,
} from '@app/shared/api/users';
import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_UPDATE_ERROR } from '@app/shared/messages/common';
import { userMsg } from '@app/shared/messages/users';
import {
  EMAIL_OTP_AVAILABLE,
  isChannelEnabled,
} from '@app/shared/validation/otp';

import { getAuditMeta } from '@/lib/audit';
import { bind } from '@/lib/http/binding';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { verifyOtpOrAutoVerify } from '@/lib/otp/verify';
import { refreshSessionCookies } from '@/lib/permissions/checker';
import { enforceOtpVerifyQuota } from '@/lib/rate-limit';
import {
  authorizeContactChange,
  commitEmailChange,
  commitPhoneChange,
  sendContactChangeCode,
} from '@/lib/users/contact-change';

const COMMIT_CONSEQUENCE =
  'On commit, Google is unlinked and every session is revoked, including the current one: show an alert that the email changed and sign-in is required, clear the authenticated state, and return to sign-in.';

/** `refreshSessionCookies` clears the cookie cache of the session the commit revoked. */
const EMAIL_COMMIT_COOKIES =
  'Session cookies are cleared after committing an email change. Every session is revoked; sign in again.';

const NO_CHANNEL =
  'Answers 503 when no channel this deployment enables can carry the code; retrying does not help until the deployment changes.';

/**
 * Initiates an email change. The new address is NEVER written to `users.email`
 * here: an OTP goes to the NEW address and `POST /change-email/verify` commits
 * it once the code matches. Under OTP_AUTO_VERIFY the deployment has opted out
 * of verification, and the change commits at once.
 */
export const changeEmailBinding = bind(changeEmail, {
  rateLimit: {
    scope: 'users.me.change-email.post',
    limit: 5,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  mapError: handleUserUniqueViolation,
  detail: {
    summary: 'Start an email-address change',
    description: `Two shapes. \`data.otpSent\` means a code is on its way to the NEW address: collect it and post it to the verify operation; nothing has changed yet and sessions remain active. \`data.autoVerified\` means the deployment verifies contacts without a code and the change has ALREADY committed. ${COMMIT_CONSEQUENCE} ${NO_CHANNEL}`,
    tags: ['Account'],
    setCookie: EMAIL_COMMIT_COOKIES,
  },
  handler: async ({ body: input, actor, meta }) => {
    const { userId, sessionId } = actor;

    // Refused up front: otherwise the code goes to a dead channel or the change
    // is stranded.
    if (!OTP_AUTO_VERIFY && !EMAIL_OTP_AVAILABLE)
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    const newEmail = input.newEmail;
    const auditMeta = getAuditMeta(meta);
    await authorizeContactChange({
      kind: 'email',
      userId,
      sessionId,
      currentPassword: input.currentPassword,
      newValue: newEmail,
      auditMeta,
    });

    if (OTP_AUTO_VERIFY) {
      await withTransaction((tx) =>
        commitEmailChange({
          tx,
          userId,
          newEmail,
          auditMeta,
        })
      );

      return {
        message: userMsg.emailChanged,
        data: { autoVerified: true } as const,
        cookies: await refreshSessionCookies(meta.headers),
      };
    }

    await sendContactChangeCode(userId, 'email', newEmail);

    return {
      message: userMsg.emailChangeCodeSent,
      data: { otpSent: true } as const,
    };
  },
});

/**
 * Step 2 of the email change: the code sent to the NEW address is verified
 * and, in the SAME transaction, the address committed and all the user's
 * sessions revoked, so there is no verify→commit replay window.
 */
export const verifyEmailChangeBinding = bind(verifyEmailChange, {
  rateLimit: {
    scope: 'users.me.change-email.verify.post',
    limit: 10,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  mapError: handleUserUniqueViolation,
  detail: {
    summary: 'Verify and commit an email-address change',
    description: `\`data.verified\` is the commit. ${COMMIT_CONSEQUENCE}`,
    tags: ['Account'],
    setCookie: EMAIL_COMMIT_COOKIES,
  },
  handler: async ({ body: input, actor, meta }) => {
    const { session, userId } = actor;
    const newEmail = input.newEmail;
    const auditMeta = getAuditMeta(meta);

    await enforceOtpVerifyQuota({
      channel: 'email',
      identifier: newEmail,
      surface: 'contact_change',
    });

    // OTP_AUTO_VERIFY commits directly, idempotent if the initiate step already
    // did. Otherwise the proof is looked up by (user, contact kind, purpose,
    // identifier), so a code can only commit the address it was issued for.
    await verifyOtpOrAutoVerify({
      userId,
      userEmail: session.user.email,
      channel: 'email',
      purpose: 'change_email',
      identifier: newEmail,
      code: input.code,
      auditMeta,
      // The address bound to the proven session, not the request body.
      onVerified: (tx, matched) =>
        commitEmailChange({
          tx,
          userId,
          newEmail: matched?.targetIdentifier ?? newEmail,
          keepVerificationSessionId: matched?.verificationSessionId,
          auditMeta,
        }),
    });

    return {
      message: userMsg.emailChanged,
      data: { verified: true } as const,
      cookies: await refreshSessionCookies(meta.headers),
    };
  },
});

/**
 * Initiates a phone-number change; like email, the new number is written only
 * once ownership is proven by OTP, or at once under OTP_AUTO_VERIFY.
 */
export const changePhoneBinding = bind(changePhone, {
  enabled: PHONE_ENABLED,
  rateLimit: {
    scope: 'users.me.change-phone.post',
    limit: 5,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  mapError: handleUserUniqueViolation,
  detail: {
    summary: 'Start a phone-number change',
    description: NO_CHANNEL,
    tags: ['Account'],
  },
  handler: async ({ body: input, actor, meta }) => {
    const { userId, sessionId } = actor;
    const { newPhoneNumber, channel } = input;

    if (!OTP_AUTO_VERIFY && !isChannelEnabled(channel))
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    const auditMeta = getAuditMeta(meta);
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

      return {
        message: userMsg.phoneChanged,
        data: { autoVerified: true } as const,
      };
    }

    await sendContactChangeCode(userId, channel, newPhoneNumber);

    return {
      message: userMsg.phoneChangeCodeSent,
      data: { otpSent: true } as const,
    };
  },
});

/**
 * Step 2 of the phone change: the code sent to the NEW number is verified and
 * the number committed in the same transaction, so there is no replay window.
 */
export const verifyPhoneChangeBinding = bind(verifyPhoneChange, {
  enabled: PHONE_ENABLED,
  rateLimit: {
    scope: 'users.me.change-phone.verify.post',
    limit: 10,
    failClosed: true,
    by: 'user',
  },
  failure: MSG_UPDATE_ERROR,
  mapError: handleUserUniqueViolation,
  detail: {
    summary: 'Verify and commit a phone-number change',
    tags: ['Account'],
  },
  handler: async ({ body: input, actor, meta }) => {
    const { session, userId, sessionId } = actor;
    const { newPhoneNumber, channel } = input;
    const auditMeta = getAuditMeta(meta);

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

    return {
      message: userMsg.phoneChanged,
      data: { verified: true } as const,
    };
  },
});
