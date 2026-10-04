/**
 * The routing codes survive the localisers.
 *
 * The login gate in `lib/auth/session/hooks.ts` raises `EMAIL_NOT_VERIFIED`, and
 * Better Auth declares a code of the same name, so `betterAuthMsg` once rewrote
 * the gate's answer to another Arabic text under `CUSTOM_AUTH_CODE` — the front-end
 * routes the user into the verification flow on the code, and got `__`.
 *
 * A SUBPROCESS: `REQUIRE_EMAIL_VERIFICATION` is a source constant and the OTP
 * channel list is read at module load, so the gate is only reachable in a
 * process configured for it.
 */
import { expect, spyOn, test } from 'bun:test';

import { APIError } from 'better-auth/api';
import * as z from 'zod';

import {
  CUSTOM_AUTH_CODE,
  EMAIL_NOT_VERIFIED_CODE,
  PHONE_NOT_VERIFIED_CODE,
  REAUTH_REQUIRED_CODE,
  TWO_FACTOR_UNAVAILABLE_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  betterAuthMsg,
  MSG_EMAIL_NOT_VERIFIED,
  MSG_PHONE_NOT_VERIFIED,
  MSG_REAUTH_REQUIRED,
  twoFactorMsg,
} from '@app/shared/messages/auth';

import {
  localisedAuthBody,
  localiseReturnedAuthError,
} from '@/lib/auth/errors';

const RUNNER = 'tests/fixtures/_email-not-verified-child.ts';

const reportSchema = z.object({
  status: z.number(),
  body: z.unknown(),
  logged: z.array(z.string()),
});

test('the login gate answers its own message under its own code, and does not log it', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', RUNNER], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' });

  // The app's request log shares stdout.
  const line = out.split('\n').find((entry) => entry.startsWith('{"status"'));
  const report = reportSchema.parse(JSON.parse(line ?? ''));

  expect(report.status).toBe(HTTP_STATUS.FORBIDDEN);
  expect(report.body).toEqual({
    message: MSG_EMAIL_NOT_VERIFIED,
    code: EMAIL_NOT_VERIFIED_CODE,
  });
  expect(report.logged).toEqual([]);
}, 60_000);

test("Better Auth's own EMAIL_NOT_VERIFIED is the same message, not a second wording", () => {
  expect(betterAuthMsg.EMAIL_NOT_VERIFIED).toBe(MSG_EMAIL_NOT_VERIFIED);
  expect(localisedAuthBody(EMAIL_NOT_VERIFIED_CODE)).toEqual({
    message: MSG_EMAIL_NOT_VERIFIED,
    code: EMAIL_NOT_VERIFIED_CODE,
  });
});

test.each([
  [PHONE_NOT_VERIFIED_CODE, MSG_PHONE_NOT_VERIFIED],
  [REAUTH_REQUIRED_CODE, MSG_REAUTH_REQUIRED],
  [TWO_FACTOR_UNAVAILABLE_CODE, twoFactorMsg.twoFactorUnavailable],
])(
  'the after hook passes %s through unchanged and does not log it',
  (code, message) => {
    const raised = new APIError('UNAUTHORIZED', { code, message });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => localiseReturnedAuthError(raised)).not.toThrow();
      expect(raised.body).toEqual({ code, message });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  }
);

test('the after hook rewrites the colliding EMAIL_NOT_VERIFIED under its own code', () => {
  const raised = new APIError('FORBIDDEN', {
    code: EMAIL_NOT_VERIFIED_CODE,
    message: 'Email not verified',
  });
  let thrown: unknown;
  try {
    localiseReturnedAuthError(raised);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(APIError);
  expect(thrown instanceof APIError && thrown.body).toEqual({
    message: MSG_EMAIL_NOT_VERIFIED,
    code: EMAIL_NOT_VERIFIED_CODE,
  });
  expect(thrown instanceof APIError && thrown.body?.code).not.toBe(
    CUSTOM_AUTH_CODE
  );
});
