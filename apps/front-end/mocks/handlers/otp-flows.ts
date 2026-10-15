import type { OfferedOption } from '../lib/two-factor-model';
import type { MockRecoveryGrant, MockUser } from '../store';
import type * as z from 'zod';

import { http, HttpResponse } from 'msw';
import { OTP_AUTO_VERIFY, PASSWORDLESS_ENABLED } from '@app/shared/config';
import { BETTER_AUTH_BODIES, REQUEST_BODIES } from '@app/shared/contract';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { otpMsg } from '@app/shared/messages/otp';
import { OTP_BASE_RESEND_DELAY_S } from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';
import { OTP_ENABLED } from '@app/shared/validation/otp';

import { requireUnspentCaptcha } from '../lib/captcha';
import {
  api,
  asPlugin,
  ok,
  parseOrThrow,
  pluginOk,
  readJson,
} from '../lib/http';
import {
  beginRecoveryAttempt,
  destinationOf,
  invalidOrExpiredCode,
  issueRecoveryGrant,
  markContactVerified,
  recordRecoveryFailure,
  resolveRecoveryGrant,
  sendAnonymousCode,
  userWithContact,
  verifyAnonymousCode,
} from '../lib/otp';
import {
  admitSession,
  issueChallenge,
  startSession,
  twoFactorUnavailable,
} from '../lib/sign-in';
import {
  endAllSessions,
  enrolmentOf,
  otpGuessWasEvaluated,
  requireServed,
  rotateCredentials,
  sendCode,
  twoFactorOf,
  verifyCode,
  writeTwoFactor,
} from '../lib/two-factor';
import {
  defaultOption,
  matchedTotpStep,
  offeredMethods,
  recoveryOptions,
} from '../lib/two-factor-model';
import { recoveryGrants, users } from '../store';

/*
 * Everything that runs on a code sent to a contact: confirming the contact,
 * signing in without a password, and recovering one. The sends answer one body
 * for a real account and an invented one, and so does every refusal of a code.
 * Their routes are the project's own and answer the API envelope; the
 * passwordless verification is a Better Auth endpoint and answers the plugin's.
 *
 * The code every send "delivers" is `MOCK_OTP_CODE`. A captcha token is spent
 * by the request that carries it, as the server spends it; a new password is
 * not checked against the breach list.
 */

const sendBody = REQUEST_BODIES['POST /api/auth/otp/send'];
const verifyBody = REQUEST_BODIES['POST /api/auth/otp/verify'];
const resetBody = REQUEST_BODIES['POST /api/auth/forgot-password/reset'];
const secondFactorSendBody =
  REQUEST_BODIES['POST /api/auth/forgot-password/second-factor/send'];
const completeBody = REQUEST_BODIES['POST /api/auth/forgot-password/complete'];

/** The wait every anonymous send advertises, whatever the identifier. */
const ANONYMOUS_SEND_DATA = { nextAllowedIn: OTP_BASE_RESEND_DELAY_S };

/** Every route here refuses a body with the same text, whatever is wrong with it. */
const parse = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> =>
  parseOrThrow(schema, body, otpMsg.invalidInput);

/** A password written by a reset: the account's own, with every credential rotated. */
function writePassword(user: MockUser, password: string) {
  users.update(user.id, { password });
  endAllSessions(user.id);
  rotateCredentials(user.id);
}

const listed = (options: readonly OfferedOption[]) =>
  options.map(({ id, method, contactKind, channel }) => ({
    id,
    method,
    contactKind,
    channel,
  }));

type FactorVerdict = 'matched' | 'rejected' | 'unavailable';

/**
 * The server's `verifyRecoveryFactor`: a TOTP code is spent, not just compared,
 * and so is a backup code. A code to a contact answers by throwing, as the
 * server's does, with the text of what was wrong with it.
 */
async function verifyFactor(
  user: MockUser,
  grant: MockRecoveryGrant,
  optionId: string,
  code: string
): Promise<FactorVerdict> {
  const row = twoFactorOf(user.id);

  if (optionId === 'totp') {
    const { totp } = row;
    if (!totp?.verified) return 'unavailable';
    const step = await matchedTotpStep(totp.secret, code);
    if (step === null || (totp.lastStep !== null && step <= totp.lastStep))
      return 'rejected';
    writeTwoFactor(user.id, { totp: { ...totp, lastStep: step } });
    return 'matched';
  }

  if (optionId === 'backup_code') {
    const { backupCodes } = row;
    if (!backupCodes) return 'unavailable';
    if (!backupCodes.codes.includes(code)) return 'rejected';
    writeTwoFactor(user.id, {
      backupCodes: {
        ...backupCodes,
        codes: backupCodes.codes.filter((unused) => unused !== code),
        remaining: backupCodes.remaining - 1,
      },
    });
    return 'matched';
  }

  const kind = optionId === 'otp:phone' ? 'phone' : 'email';
  const destination = kind === 'email' ? user.email : user.phoneNumber;
  if (!destination) throw invalidOrExpiredCode();
  try {
    verifyCode(user.id, 'two_factor', destination, code);
  } catch (error) {
    // Only a code that was compared and lost is a guess.
    if (otpGuessWasEvaluated(error)) recordRecoveryFailure(grant);
    throw error;
  }
  return 'matched';
}

export const otpFlowHandlers = [
  http.post(api('/api/auth/otp/send'), async ({ request }) => {
    requireServed(OTP_ENABLED);
    requireUnspentCaptcha(request);
    const contact = parse(sendBody, await readJson(request));
    const user = userWithContact(contact);
    const kind = contactKindOf(contact.channel);
    const verified =
      kind === 'email' ? user?.emailVerified : user?.phoneNumberVerified;
    // A contact that is already verified gets nothing, answered like an unknown one.
    if (user && !verified) {
      if (OTP_AUTO_VERIFY) markContactVerified(user, kind);
      else sendAnonymousCode(user, 'verify_contact', destinationOf(contact));
    }
    return ok(ANONYMOUS_SEND_DATA, otpMsg.sendSuccess);
  }),

  http.post(api('/api/auth/otp/verify'), async ({ request }) => {
    requireServed(OTP_ENABLED);
    requireUnspentCaptcha(request);
    const input = parse(verifyBody, await readJson(request));
    const user = userWithContact(input);
    if (!user) throw invalidOrExpiredCode();

    verifyAnonymousCode(
      user,
      'verify_contact',
      destinationOf(input),
      input.code
    );
    markContactVerified(user, contactKindOf(input.channel));
    return ok({ verified: true }, otpMsg.verifySuccess(input.channel));
  }),

  http.post(api('/api/auth/passwordless/send'), async ({ request }) => {
    requireServed(OTP_ENABLED && PASSWORDLESS_ENABLED);
    requireUnspentCaptcha(request);
    const contact = parse(sendBody, await readJson(request));
    const user = userWithContact(contact);
    if (user)
      sendAnonymousCode(user, 'passwordless_login', destinationOf(contact));
    return ok(ANONYMOUS_SEND_DATA, otpMsg.sendSuccess);
  }),

  http.post(api('/api/auth/forgot-password/send'), async ({ request }) => {
    requireServed(OTP_ENABLED);
    requireUnspentCaptcha(request);
    const contact = parse(sendBody, await readJson(request));
    const user = userWithContact(contact);
    if (user)
      sendAnonymousCode(user, 'forgot_password', destinationOf(contact));
    return ok(ANONYMOUS_SEND_DATA, otpMsg.sendSuccess);
  }),

  // The code proves the contact. An account with a second factor gets a grant
  // instead of a new password, which a factor's own proof then spends.
  http.post(api('/api/auth/forgot-password/reset'), async ({ request }) => {
    requireServed(OTP_ENABLED);
    requireUnspentCaptcha(request);
    const input = parse(resetBody, await readJson(request));
    const user = userWithContact(input);
    if (!user) throw invalidOrExpiredCode();

    const kind = contactKindOf(input.channel);
    verifyAnonymousCode(
      user,
      'forgot_password',
      destinationOf(input),
      input.code
    );

    const state = enrolmentOf(user);
    const allowed = recoveryOptions(state, kind);
    // Refused: a second factor on the contact the code reached, or one this
    // flow cannot check, proves nothing. An account with none it could use
    // anyway is already refused at sign-in, so it resets (the server's trap).
    if (
      state.enabled &&
      allowed.length === 0 &&
      offeredMethods(state).length > 0
    )
      throw new CustomError(
        otpMsg.recoveryBlockedByTwoFactor,
        HTTP_STATUS.FORBIDDEN
      );

    if (state.enabled && allowed.length > 0) {
      const grant = issueRecoveryGrant(
        user,
        kind,
        allowed.map(({ id }) => id)
      );
      return ok(
        {
          reset: false,
          twoFactorRequired: true,
          grant,
          options: listed(allowed),
          defaultMethod: defaultOption(allowed),
        },
        otpMsg.recoverySecondFactorRequired
      );
    }

    writePassword(user, input.newPassword);
    return ok({ reset: true }, otpMsg.passwordResetSuccess);
  }),

  http.post(
    api('/api/auth/forgot-password/second-factor/send'),
    async ({ request }) => {
      requireServed(OTP_ENABLED);
      const { grant: token, option } = parse(
        secondFactorSendBody,
        await readJson(request)
      );
      const grant = resolveRecoveryGrant(token, option);
      const user = users.find(grant.userId);
      if (!user || (option !== 'otp:email' && option !== 'otp:phone'))
        throw invalidOrExpiredCode();

      const kind = option === 'otp:phone' ? 'phone' : 'email';
      const destination = kind === 'email' ? user.email : user.phoneNumber;
      if (!destination) throw invalidOrExpiredCode();

      const nextAllowedIn = sendCode(user.id, 'two_factor', destination, kind);
      return ok({ nextAllowedIn }, otpMsg.sendSuccess);
    }
  ),

  // The only write of the password for an account with a second factor: the
  // grant, one of the factors it lists proven, and the five attempts they share.
  http.post(api('/api/auth/forgot-password/complete'), async ({ request }) => {
    requireServed(OTP_ENABLED);
    const input = parse(completeBody, await readJson(request));
    const grant = resolveRecoveryGrant(input.grant, input.option);
    const user = users.find(grant.userId);
    if (!user?.isActive) throw invalidOrExpiredCode();

    beginRecoveryAttempt(grant);
    const verdict = await verifyFactor(user, grant, input.option, input.code);
    if (verdict !== 'matched') {
      if (verdict === 'rejected') recordRecoveryFailure(grant);
      throw new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);
    }

    recoveryGrants.remove(grant.id);
    writePassword(user, input.newPassword);
    return ok({ reset: true }, otpMsg.passwordResetSuccess);
  }),

  asPlugin(
    http.post(api('/api/auth/passwordless/verify'), async ({ request }) => {
      requireServed(OTP_ENABLED && PASSWORDLESS_ENABLED);
      requireUnspentCaptcha(request);
      const input = parse(
        BETTER_AUTH_BODIES['/passwordless/verify'],
        await readJson(request)
      );
      const user = userWithContact(input);
      if (!user) throw invalidOrExpiredCode();

      const kind = contactKindOf(input.channel);
      verifyAnonymousCode(
        user,
        'passwordless_login',
        destinationOf(input),
        input.code
      );
      markContactVerified(user, kind);

      // Like a password login, it passes the session gates, and the contact
      // the code reached is not offered again as a second factor.
      admitSession(user);
      const outcome = issueChallenge(user, {
        firstFactor: 'passwordless',
        rememberMe: input.rememberMe ?? true,
        excludeContactKind: kind,
      });
      if (outcome.kind === 'refused') throw twoFactorUnavailable();
      if (outcome.kind === 'challenge') return HttpResponse.json(outcome.body);

      startSession(user);
      return pluginOk({ loggedIn: true }, otpMsg.loginSuccess);
    })
  ),
];
