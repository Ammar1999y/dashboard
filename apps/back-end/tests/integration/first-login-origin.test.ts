/**
 * Origin validation on the two paths a browser reaches with no cookie at all,
 * judged by ROW STATE rather than by status alone.
 *
 * Better Auth's router-level origin check skips a cookie-less request and leaves
 * it to the endpoint's own `formCsrfMiddleware`, which runs AFTER `hooks.before`
 * — where `lib/auth/index.ts` runs the real password verification for `/sign-in/email`
 * and where `/passwordless/verify`, a local endpoint, declared no such middleware
 * at all. So an untrusted origin used to answer 403 only after the password had
 * been compared, the failed-attempt counter charged, or the OTP consumed and a
 * session row written. The hook now runs the same check first.
 *
 * Each refusal below is therefore asserted from three sides: the status and the
 * localised body, no session row, and the credential state untouched — a wrong
 * password that charged nothing, a correct code that is still live.
 *
 * A browser completing a passwordless sign-in is never cookie-less any more: the
 * code is bound to its requester cookie (`lib/otp/challenge.ts`), which puts the
 * verify under the router-level check too. The cookie-less refusals still hold.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  otpChallenges,
  sessions,
  users,
  verificationSessions,
} from '@/db/schema';

import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { betterAuthMsg } from '@app/shared/messages/auth';

import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import { expectAuthError } from '../helpers/expect-body';
import { seedOtpProof } from '../helpers/otp';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const UNTRUSTED_ORIGIN = 'https://attacker.example';

/** Satisfies `passwordSchema`, so a refusal cannot come from input validation. */
const WRONG_PASSWORD = 'Harness!Wr0ngPass';

const CODE = '424242';

type ProofUser = SeededUser & { otpCookie: string };

interface FirstLoginPath {
  path: string;
  /** A body that is VALID for the path, so nothing short of the origin refuses it. */
  body: (user: SeededUser) => Record<string, unknown>;
  /** A body that reaches the credential check and fails it. */
  wrongBody: (user: SeededUser) => Record<string, unknown>;
  /** What a browser completing this path carries beyond its headers. */
  browserCookies: (user: ProofUser) => Record<string, string>;
}

const PATHS: readonly FirstLoginPath[] = [
  {
    path: '/sign-in/email',
    body: (user) => ({ email: user.email, password: user.password }),
    wrongBody: (user) => ({ email: user.email, password: WRONG_PASSWORD }),
    browserCookies: () => ({}),
  },
  {
    path: '/passwordless/verify',
    body: (user) => ({ channel: 'email', email: user.email, code: CODE }),
    wrongBody: (user) => ({
      channel: 'email',
      email: user.email,
      code: '000000',
    }),
    browserCookies: (user) => ({ cookie: user.otpCookie }),
  },
];

function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/auth${path}`, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json', ...headers }),
      body: JSON.stringify(body),
    })
  );
}

interface CredentialState {
  failedLoginAttempts: number;
  sessions: number;
  auditRows: number;
  /** Live, unconsumed code rows for the user's passwordless proof. */
  liveCodes: number;
  /** Guesses charged to that code. */
  verifyAttempts: number;
}

async function credentialState(userId: string): Promise<CredentialState> {
  const [user] = await db
    .select({ failedLoginAttempts: users.failedLoginAttempts })
    .from(users)
    .where(eq(users.id, userId));
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const audit = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId));
  const codes = await db
    .select({ guesses: otpChallenges.guesses })
    .from(otpChallenges)
    .innerJoin(
      verificationSessions,
      eq(verificationSessions.id, otpChallenges.sessionId)
    )
    .where(eq(verificationSessions.userId, userId));

  return {
    failedLoginAttempts: user?.failedLoginAttempts ?? -1,
    sessions: sessionRows.length,
    auditRows: audit.length,
    liveCodes: codes.length,
    verifyAttempts: codes[0]?.guesses ?? -1,
  };
}

/** The state a user has before any request: one live proof, nothing charged. */
const UNTOUCHED: CredentialState = {
  failedLoginAttempts: 0,
  sessions: 0,
  auditRows: 0,
  liveCodes: 1,
  verifyAttempts: 0,
};

async function seedUserWithProof(): Promise<ProofUser> {
  const user = await seedUser();
  const { cookie } = await seedOtpProof({
    userId: user.userId,
    identifier: user.email,
    purpose: 'passwordless_login',
    code: CODE,
  });
  return { ...user, otpCookie: cookie };
}

beforeAll(async () => {
  await resetTables();
});

beforeEach(() => {
  resetSqliteStores();
});

/**
 * Every header shape Better Auth's `validateFormCsrf` refuses for a cookie-less
 * request. The three error codes all localise to the one untrusted-origin
 * message, and the status is the same, so a client cannot tell which rule fired.
 */
const REFUSED_HEADERS: readonly [string, Record<string, string>][] = [
  ['an untrusted Origin', { origin: UNTRUSTED_ORIGIN }],
  [
    'an untrusted Referer and no Origin',
    { referer: `${UNTRUSTED_ORIGIN}/login` },
  ],
  [
    'a cross-site navigation (a form post from another site)',
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  ],
  [
    'a cross-site fetch carrying its Origin',
    {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      origin: UNTRUSTED_ORIGIN,
    },
  ],
  ['Origin: null', { origin: 'null' }],
  [
    'fetch metadata with no Origin or Referer to validate',
    { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
  ],
];

describe.each([...PATHS])(
  '$path with no cookie',
  ({ path, body, wrongBody, browserCookies }) => {
    test.each(REFUSED_HEADERS)(
      '%s is refused before any credential or database work',
      async (_label, headers) => {
        const user = await seedUserWithProof();

        // The CORRECT credential, so that "still live" is the proof: had the
        // request reached verification, the code would be consumed or the
        // password accepted and a session row written.
        const response = await post(path, body(user), headers);

        expect(
          await expectAuthError(
            response,
            HTTP_STATUS.FORBIDDEN,
            betterAuthMsg.INVALID_ORIGIN
          )
        ).toMatchObject({ code: CUSTOM_AUTH_CODE });
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
      }
    );

    test('an untrusted Origin with a WRONG credential charges nothing either', async () => {
      // The counter is the discriminator: a wrong password that reached
      // `verifyLoginAttempt` records a failed attempt, and a wrong code that
      // reached `processOtpVerify` records a verify attempt.
      const user = await seedUserWithProof();

      const response = await post(path, wrongBody(user), {
        origin: UNTRUSTED_ORIGIN,
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
    });

    test('the same Origin as PUBLIC_ORIGIN, as a browser sends it, proceeds', async () => {
      const user = await seedUserWithProof();

      const response = await post(path, body(user), {
        ...browserCookies(user),
        origin: PUBLIC_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
      const state = await credentialState(user.userId);
      expect(state.sessions).toBe(1);
    });

    test('no Origin, Referer or fetch metadata at all is admitted, and reaches the credentials', async () => {
      // Better Auth's documented allowance for non-browser clients: there is
      // nothing to validate, so nothing refuses. Recorded here so the contract is
      // visible — this request DOES reach the credential check, and the wrong
      // credential is charged.
      const user = await seedUserWithProof();

      const response = await post(path, wrongBody(user), {});

      expect(response.status).not.toBe(HTTP_STATUS.FORBIDDEN);
      expect(response.status).toBeGreaterThanOrEqual(HTTP_STATUS.BAD_REQUEST);
      const state = await credentialState(user.userId);
      expect(state.sessions).toBe(0);
      // A code is reached only with its requester cookie, and carrying one
      // brings the router-level check: this client gets no guess at all.
      if (path === '/sign-in/email') expect(state.failedLoginAttempts).toBe(1);
      else expect(state).toEqual(UNTOUCHED);
    });

    test('with a cookie present, an untrusted Origin is refused by the router-level check', async () => {
      // Any cookie at all switches Better Auth to its cookie-bearing rule, which
      // validates the Origin on every non-GET request ahead of every hook.
      const user = await seedUserWithProof();

      const response = await post(path, body(user), {
        cookie: 'unrelated=1',
        origin: UNTRUSTED_ORIGIN,
      });

      expect(
        await expectAuthError(
          response,
          HTTP_STATUS.FORBIDDEN,
          betterAuthMsg.INVALID_ORIGIN
        )
      ).toMatchObject({ code: CUSTOM_AUTH_CODE });
      expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
    });

    test('with a cookie present and no Origin at all, the request is refused', async () => {
      const user = await seedUserWithProof();

      const response = await post(path, body(user), { cookie: 'unrelated=1' });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
    });
  }
);
