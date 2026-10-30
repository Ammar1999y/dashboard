import { createHash } from 'node:crypto';
import type { HandlerCookie } from '@/lib/http/contract';

import { randomToken } from '@/lib/auth/verifications';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { OTP_MAX_CHALLENGE_GUESSES } from './limits';

const SECURE = PUBLIC_ORIGIN.startsWith('https://');

/**
 * The browser an anonymous code was sent to. `__Host-` under https forbids
 * `Domain`, so a sibling subdomain cannot plant one.
 */
export const REQUESTER_COOKIE = SECURE
  ? '__Host-otp_requester'
  : 'otp_requester';

const REQUESTER_BYTES = 32;
const REQUESTER_PATTERN = /^[\w-]{43}$/;
const REQUESTER_MAX_AGE_S = 30 * 24 * 60 * 60;

/** `null` when absent, malformed, or sent twice: which one was meant is unknowable. */
export function readRequester(headers: Headers): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  let found: string | null = null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(0, eq).trim() !== REQUESTER_COOKIE) continue;
    if (found !== null) return null;
    found = pair.slice(eq + 1).trim();
  }
  return found !== null && REQUESTER_PATTERN.test(found) ? found : null;
}

/**
 * ⚠️ Decided by the incoming cookie alone, and answered on every send that
 * passes the pre-lookup gates: anything account-dependent here is an existence
 * oracle.
 */
export function requesterFor(headers: Headers): {
  requester: string;
  cookie: HandlerCookie;
} {
  const requester = readRequester(headers) ?? randomToken(REQUESTER_BYTES);
  return {
    requester,
    cookie: {
      name: REQUESTER_COOKIE,
      value: requester,
      options: {
        path: '/',
        httpOnly: true,
        secure: SECURE,
        sameSite: 'lax',
        maxAge: REQUESTER_MAX_AGE_S,
      },
    },
  };
}

/** The `Set-Cookie` every anonymous send answers, account or not. */
export const REQUESTER_SET_COOKIE =
  'Binds the code to this browser. Only a request carrying this cookie can redeem it, and a send from another browser issues a separate code that leaves this one valid.';

/** For each verify that redeems an anonymous send's code. */
export const REQUESTER_BOUND_VERIFY = `Redeems the code sent to the browser whose cookie this request carries; without that cookie the answer is the wrong-code one. Each code allows ${OTP_MAX_CHALLENGE_GUESSES} guesses, after which a new one must be requested.`;

export function requesterKey(requester: string): string {
  return createHash('sha256').update(requester).digest('hex');
}
