import type { MockOAuthResult } from '../store';

import * as contract from '@app/shared/api/better-auth';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_CREDENTIALS } from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import {
  googleStartSchema,
  OAUTH_PROVIDERS,
} from '@app/shared/validation/oauth';

import { requireUnspentCaptcha } from '../lib/captcha';
import { mock } from '../lib/endpoint';
import { readJson } from '../lib/http';
import { mayHoldSession } from '../lib/permissions';
import { issueChallenge, startSession } from '../lib/sign-in';
import { oauthResult, users } from '../store';

/*
 * Google sign-in, without Google. Starting hands the browser straight to the
 * completion page, and the callback's work happens then: the account
 * `MOCK_GOOGLE_EMAIL` is signed in (its session cookie delivered, as the
 * callback delivers it before redirecting), or answered with a challenge, and
 * the outcome waits for `/oauth/result`, which hands it over once. Google never
 * proves a second factor here, so an account that holds one is challenged with
 * every contact but its email, as the server does.
 */

const MOCK_GOOGLE_EMAIL = 'admin@gmail.com';

/** The server's `OAUTH_RESULT_MAX_AGE_S`. */
const RESULT_TTL_S = 60;

const origin = () => globalThis.location?.origin ?? 'http://localhost';

const denied = () =>
  new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);

/** The server's `returnURL`: this origin only, with no credentials and no fragment. */
function returnURL(input: string | undefined): string | null {
  if (!input) return null;
  const url = URL.parse(input, origin());
  if (
    !url ||
    url.origin !== origin() ||
    url.username ||
    url.password ||
    url.hash
  )
    throw denied();
  return url.href;
}

/** What the callback leaves for `/oauth/result`; `null` is a refused sign-in. */
function callbackOutcome(rememberMe: boolean): MockOAuthResult['body'] {
  const user = users.all().find((row) => row.email === MOCK_GOOGLE_EMAIL);
  if (!user || !mayHoldSession(user)) return null;

  const outcome = issueChallenge(user, {
    firstFactor: 'google',
    rememberMe,
    excludeContactKind: 'email',
  });
  if (outcome.kind === 'refused') return null;
  if (outcome.kind === 'challenge') return { ...outcome.body };

  startSession(user);
  return { data: { loggedIn: true as const } };
}

export const oauthHandlers = [
  mock(contract.authCapabilities, () => ({
    raw: { data: { oauthProviders: [...OAUTH_PROVIDERS] } },
  })),

  mock(contract.googleStart, async ({ request }) => {
    requireUnspentCaptcha(request);
    const parsed = googleStartSchema.safeParse(await readJson(request));
    if (!parsed.success)
      throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);

    const destination = returnURL(parsed.data.callbackURL);
    if (destination)
      oauthResult.set({
        body: callbackOutcome(parsed.data.rememberMe ?? true),
        expiresAt: new Date(Date.now() + RESULT_TTL_S * 1000).toISOString(),
      });
    return {
      raw: { data: { url: destination ?? new URL('/dash', origin()).href } },
    };
  }),

  mock(contract.oauthResult, () => {
    const result = oauthResult.get();
    oauthResult.set(null);
    if (!result || Date.parse(result.expiresAt) <= Date.now()) throw denied();
    if (!result.body) throw denied();
    return { raw: result.body };
  }),
];
