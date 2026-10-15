import type { OfferedOption } from '../lib/two-factor-model';
import type { MockUser } from '../store';

import { http, HttpResponse } from 'msw';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';
import {
  isTwoFactorMethodEnabled,
  isTwoFactorOtpChannelEnabled,
  TWO_FACTOR_OTP_AVAILABLE,
  twoFactorOtpVerifySchema,
  twoFactorPasskeyVerifySchema,
} from '@app/shared/validation/two-factor';

import { api, asPlugin, parseOrThrow, pluginOk, readJson } from '../lib/http';
import {
  beginAttempt,
  completeChallenge,
  recordFailure,
  requireChallenge,
} from '../lib/sign-in';
import {
  otpGuessWasEvaluated,
  requireServed,
  sendCode,
  twoFactorOf,
  verifyCode,
  writeTwoFactor,
} from '../lib/two-factor';
import { matchedTotpStep, randomToken } from '../lib/two-factor-model';
import { challenge, session } from '../store';

/*
 * The second half of a sign-in: the endpoints that take the challenge a first
 * factor issued (`lib/sign-in.ts`) and answer a session. The library's TOTP and
 * backup-code verifiers answer plain JSON, the project's own the plugin shape;
 * both refuse in Better Auth's `{ code, message }`.
 */

const invalidCode = () =>
  new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.UNAUTHORIZED);

const methodUnavailable = () =>
  new CustomError(twoFactorMsg.methodUnavailable, HTTP_STATUS.BAD_REQUEST);

/** The library validates `{ code }` before the endpoint runs. */
async function readCode(request: Request): Promise<string> {
  const { code } = await readJson(request);
  if (typeof code !== 'string')
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
  return code;
}

/** The library's answer to a verified code: the session's token and its user. */
function signedIn(user: MockUser) {
  const { session: started, user: sessionUser } = completeChallenge(user);
  return HttpResponse.json({ token: started.token, user: sessionUser });
}

/**
 * The server's `otpTargetFor`: only an offered option, or the default's, so a
 * request cannot name a contact the challenge left out. The destination is the
 * account's own, never the request's.
 */
function otpTarget(
  user: MockUser,
  options: readonly OfferedOption[],
  defaultMethod: string | null,
  requested: unknown
) {
  const candidates = options.filter(({ method }) => method === 'otp');
  const chosen =
    typeof requested === 'string'
      ? candidates.find(({ id }) => id === requested)
      : (candidates.find(({ id }) => id === defaultMethod) ?? candidates[0]);
  if (!chosen?.channel || !isTwoFactorOtpChannelEnabled(chosen.channel))
    throw methodUnavailable();

  const kind = contactKindOf(chosen.channel);
  const destination = kind === 'email' ? user.email : user.phoneNumber;
  if (!destination) throw methodUnavailable();
  return { option: chosen, kind, destination };
}

export const signInChallengeHandlers = [
  http.post(api('/api/auth/two-factor/verify-totp'), async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('totp'));
    const code = await readCode(request);
    const { user } = requireChallenge({ method: 'totp', signInOnly: true });
    beginAttempt();

    const { totp } = twoFactorOf(user.id);
    const step = totp?.verified
      ? await matchedTotpStep(totp.secret, code)
      : null;
    // A step already used is a wrong code, so a replay costs an attempt.
    if (
      !totp ||
      step === null ||
      (totp.lastStep !== null && step <= totp.lastStep)
    ) {
      recordFailure();
      throw invalidCode();
    }
    writeTwoFactor(user.id, { totp: { ...totp, lastStep: step } });
    return signedIn(user);
  }),

  http.post(
    api('/api/auth/two-factor/verify-backup-code'),
    async ({ request }) => {
      requireServed(isTwoFactorMethodEnabled('backup_code'));
      const code = await readCode(request);
      const { user } = requireChallenge({
        method: 'backup_code',
        signInOnly: true,
      });
      beginAttempt();

      const { backupCodes } = twoFactorOf(user.id);
      if (!backupCodes?.codes.includes(code)) {
        recordFailure();
        throw invalidCode();
      }
      writeTwoFactor(user.id, {
        backupCodes: {
          ...backupCodes,
          codes: backupCodes.codes.filter((unused) => unused !== code),
          remaining: backupCodes.remaining - 1,
        },
      });
      return signedIn(user);
    }
  ),

  // The sign-in half only. With a session the request is an enrolment, which
  // the account's handler answers: nothing here, so it is theirs.
  http.post(api('/api/auth/two-factor/otp/send'), async ({ request }) => {
    requireServed(TWO_FACTOR_OTP_AVAILABLE);
    if (session.get()) return;
    const body = await readJson(request);
    const { user, options, issued } = requireChallenge();
    const { kind, destination } = otpTarget(
      user,
      options,
      issued.defaultMethod,
      body.option
    );
    const nextAllowedIn = sendCode(user.id, 'two_factor', destination, kind);
    return pluginOk({ nextAllowedIn }, twoFactorMsg.codeSent);
  }),

  http.post(api('/api/auth/two-factor/otp/verify'), async ({ request }) => {
    requireServed(TWO_FACTOR_OTP_AVAILABLE);
    if (session.get()) return;
    const body = await readJson(request);
    const { code } = parseOrThrow(
      twoFactorOtpVerifySchema,
      body,
      otpMsg.invalidInput
    );
    const { user, options, issued } = requireChallenge();
    const { destination } = otpTarget(
      user,
      options,
      issued.defaultMethod,
      body.option
    );
    beginAttempt();

    try {
      verifyCode(user.id, 'two_factor', destination, code);
    } catch (error) {
      if (!(error instanceof CustomError)) throw error;
      // Only a code that was compared and lost is a guess; a code that was
      // never sent or has expired compared nothing, and costs no attempt.
      if (otpGuessWasEvaluated(error)) recordFailure();
      throw error.status === HTTP_STATUS.TOO_MANY_REQUESTS
        ? error
        : new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);
    }
    completeChallenge(user);
    return pluginOk({ loggedIn: true }, otpMsg.loginSuccess);
  }),

  http.post(api('/api/auth/two-factor/passkey/options'), () => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const { issued, user } = requireChallenge({ method: 'passkey' });
    const { passkeys } = twoFactorOf(user.id);
    if (passkeys.length === 0) throw methodUnavailable();

    // Only the newest options stay live for a challenge.
    const ceremony = randomToken(32);
    challenge.set({ ...issued, ceremony });
    return pluginOk({
      challenge: ceremony,
      rpId: globalThis.location?.hostname ?? 'localhost',
      allowCredentials: passkeys.map(({ credentialId }) => ({
        id: credentialId,
        type: 'public-key',
      })),
      userVerification: 'required',
      timeout: 60_000,
    });
  }),

  // Nothing here can check what an authenticator signed: the assertion is
  // accepted for a credential the account holds, as a registration is trusted.
  http.post(api('/api/auth/two-factor/passkey/verify'), async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const { issued, user } = requireChallenge({ method: 'passkey' });
    const { response } = parseOrThrow(
      twoFactorPasskeyVerifySchema,
      await readJson(request),
      twoFactorMsg.invalidCode
    );
    beginAttempt();

    // A ceremony that was never started, or already spent, compared nothing.
    if (issued.ceremony === null)
      throw new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);
    challenge.set({ ...issued, ceremony: null });

    const known = twoFactorOf(user.id).passkeys.some(
      ({ credentialId }) => credentialId === response.id
    );
    if (!known) {
      recordFailure();
      throw invalidCode();
    }
    completeChallenge(user);
    return pluginOk({ loggedIn: true }, twoFactorMsg.verifySuccess);
  }),
].map(asPlugin);
