import type { MockUser } from '../store';
import type { ContactKind } from '@app/shared/validation/enums';

import {
  changeEmail,
  changePassword,
  changePhone,
  verifyEmailChange,
  verifyPhoneChange,
} from '@app/shared/api/users';
import { PHONE_ENABLED } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import {
  MSG_EMAIL_EXISTS,
  MSG_PHONE_EXISTS,
  userMsg,
} from '@app/shared/messages/users';
import {
  EMAIL_OTP_AVAILABLE,
  isChannelEnabled,
} from '@app/shared/validation/otp';

import { requireUnspentCaptcha } from '../lib/captcha';
import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { insufficientPermissions } from '../lib/permissions';
import {
  endAllSessions,
  enrolmentOf,
  removeMethodIntent,
  requireReauthProof,
  requireServed,
  requireSessionUser,
  rotateCredentials,
  sendCode,
  verifyCode,
} from '../lib/two-factor';
import { contactChangeStrands } from '../lib/two-factor-model';
import { users } from '../store';

const unavailable = () =>
  new CustomError(
    userMsg.verificationUnavailable,
    HTTP_STATUS.SERVICE_UNAVAILABLE
  );

/**
 * The server's `authorizeContactChange`, which runs before any code is sent:
 * the proof (a password sent with the request, or the open window), a live
 * account with a role, a value that differs from the current one, and a change
 * that leaves a second factor the account can still complete. A value another
 * account holds is not refused here: before ownership is proven that would
 * tell who is registered.
 */
function authorizeContactChange(
  user: MockUser,
  kind: ContactKind,
  currentPassword: string | undefined,
  newValue: string
) {
  requireReauthProof(currentPassword);
  if (!user.roleId) throw insufficientPermissions();
  const isEmail = kind === 'email';
  if ((isEmail ? user.email : user.phoneNumber) === newValue)
    throw new CustomError(
      isEmail ? userMsg.newEmailSameAsCurrent : userMsg.newPhoneSameAsCurrent,
      HTTP_STATUS.BAD_REQUEST
    );
  if (contactChangeStrands(enrolmentOf(user), [kind]))
    throw new CustomError(
      twoFactorMsg.contactChangeStrands,
      HTTP_STATUS.CONFLICT
    );
}

export const accountHandlers = [
  mock(changeEmail, async ({ request, body }) => {
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await body();
    if (!EMAIL_OTP_AVAILABLE) throw unavailable();

    authorizeContactChange(
      user,
      'email',
      input.currentPassword,
      input.newEmail
    );
    sendCode(user.id, 'change_email', input.newEmail, 'email');
    return {
      message: userMsg.emailChangeCodeSent,
      data: { otpSent: true as const },
    };
  }),

  // The commit revokes every session, the current one too: the browser holds a
  // cookie for a session that no longer exists.
  mock(verifyEmailChange, async ({ request, body }) => {
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await body();
    verifyCode(user.id, 'change_email', input.newEmail, input.code);

    if (!user.roleId) throw insufficientPermissions();
    if (contactChangeStrands(enrolmentOf(user), ['email']))
      throw new CustomError(
        twoFactorMsg.contactChangeStrands,
        HTTP_STATUS.CONFLICT
      );
    if (
      users
        .all()
        .some(
          (other) =>
            other.id !== user.id &&
            other.email.toLowerCase() === input.newEmail.toLowerCase()
        )
    )
      throw new CustomError(MSG_EMAIL_EXISTS, HTTP_STATUS.CONFLICT);

    users.update(user.id, {
      email: input.newEmail,
      emailVerified: true,
      updatedAt: now(),
    });
    removeMethodIntent(user.id, 'otp', 'email');
    rotateCredentials(user.id, 'revoke');
    endAllSessions(user.id);
    return {
      message: userMsg.emailChanged,
      data: { verified: true as const },
    };
  }),

  mock(changePassword, async ({ request, body }) => {
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await body();

    if (input.currentPassword === input.newPassword)
      throw new CustomError(
        userMsg.newPasswordSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    requireReauthProof(input.currentPassword);
    // Without a password the window is the proof, so the stored one is what
    // the new one is compared against.
    if (
      input.currentPassword === undefined &&
      input.newPassword === user.password
    )
      throw new CustomError(
        userMsg.newPasswordSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    users.update(user.id, { password: input.newPassword });
    // A voluntary change keeps the trusted devices: the old password was proven
    // on a live session, so this is the owner.
    rotateCredentials(user.id, 'keep');
    return { message: userMsg.passwordChanged, data: null };
  }),

  mock(changePhone, async ({ request, body }) => {
    requireServed(PHONE_ENABLED);
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await body();
    if (!isChannelEnabled(input.channel)) throw unavailable();

    authorizeContactChange(
      user,
      'phone',
      input.currentPassword,
      input.newPhoneNumber
    );
    sendCode(user.id, 'change_phone', input.newPhoneNumber, 'phone');
    return {
      message: userMsg.phoneChangeCodeSent,
      data: { otpSent: true as const },
    };
  }),

  mock(verifyPhoneChange, async ({ request, body }) => {
    requireServed(PHONE_ENABLED);
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await body();
    verifyCode(user.id, 'change_phone', input.newPhoneNumber, input.code);

    if (!user.roleId) throw insufficientPermissions();
    if (contactChangeStrands(enrolmentOf(user), ['phone']))
      throw new CustomError(
        twoFactorMsg.contactChangeStrands,
        HTTP_STATUS.CONFLICT
      );
    if (
      users
        .all()
        .some(
          (other) =>
            other.id !== user.id && other.phoneNumber === input.newPhoneNumber
        )
    )
      throw new CustomError(MSG_PHONE_EXISTS, HTTP_STATUS.CONFLICT);

    users.update(user.id, {
      phoneNumber: input.newPhoneNumber,
      phoneNumberVerified: true,
      updatedAt: now(),
    });
    removeMethodIntent(user.id, 'otp', 'phone');
    // The phone is a passwordless factor, so this rotates credentials; the
    // current session is kept.
    rotateCredentials(user.id, 'revoke');
    return {
      message: userMsg.phoneChanged,
      data: { verified: true as const },
    };
  }),
];
