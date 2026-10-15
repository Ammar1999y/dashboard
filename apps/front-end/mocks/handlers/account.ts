import type { MockUser } from '../store';
import type { ContactKind } from '@app/shared/validation/enums';

import { http } from 'msw';
import { PHONE_ENABLED } from '@app/shared/config';
import { REQUEST_BODIES } from '@app/shared/contract';
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
import { api, ok, readJsonBody } from '../lib/http';
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

const emailBody = REQUEST_BODIES['POST /api/dash/users/me/change-email'];
const emailVerifyBody =
  REQUEST_BODIES['POST /api/dash/users/me/change-email/verify'];
const passwordBody = REQUEST_BODIES['POST /api/dash/users/me/change-password'];
const phoneBody = REQUEST_BODIES['POST /api/dash/users/me/change-phone'];
const phoneVerifyBody =
  REQUEST_BODIES['POST /api/dash/users/me/change-phone/verify'];

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
  http.post(api('/api/dash/users/me/change-email'), async ({ request }) => {
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await readJsonBody(request, emailBody);
    if (!EMAIL_OTP_AVAILABLE) throw unavailable();

    authorizeContactChange(
      user,
      'email',
      input.currentPassword,
      input.newEmail
    );
    sendCode(user.id, 'change_email', input.newEmail, 'email');
    return ok({ otpSent: true }, userMsg.emailChangeCodeSent);
  }),

  // The commit revokes every session, the current one too: the browser holds a
  // cookie for a session that no longer exists.
  http.post(
    api('/api/dash/users/me/change-email/verify'),
    async ({ request }) => {
      const user = requireSessionUser();
      requireUnspentCaptcha(request);
      const input = await readJsonBody(request, emailVerifyBody);
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
      return ok({ verified: true }, userMsg.emailChanged);
    }
  ),

  http.post(api('/api/dash/users/me/change-password'), async ({ request }) => {
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await readJsonBody(request, passwordBody);

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
    return ok(null, userMsg.passwordChanged);
  }),

  http.post(api('/api/dash/users/me/change-phone'), async ({ request }) => {
    requireServed(PHONE_ENABLED);
    const user = requireSessionUser();
    requireUnspentCaptcha(request);
    const input = await readJsonBody(request, phoneBody);
    if (!isChannelEnabled(input.channel)) throw unavailable();

    authorizeContactChange(
      user,
      'phone',
      input.currentPassword,
      input.newPhoneNumber
    );
    sendCode(user.id, 'change_phone', input.newPhoneNumber, 'phone');
    return ok({ otpSent: true }, userMsg.phoneChangeCodeSent);
  }),

  http.post(
    api('/api/dash/users/me/change-phone/verify'),
    async ({ request }) => {
      requireServed(PHONE_ENABLED);
      const user = requireSessionUser();
      requireUnspentCaptcha(request);
      const input = await readJsonBody(request, phoneVerifyBody);
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
      return ok({ verified: true }, userMsg.phoneChanged);
    }
  ),
];
