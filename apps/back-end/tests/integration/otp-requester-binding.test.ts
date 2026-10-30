/**
 * Codes anyone can request by naming a contact are bound to the browser that
 * asked (`lib/otp/challenge.ts`). Before, every requester shared one proof row:
 * a stranger's send replaced the owner's code, and a stranger's wrong guesses
 * spent the row's daily budget and then refused the owner's correct one for a
 * day (audit opus-5.5 #4), or held its sends in a six-hour block (OTP-2).
 *
 * Every refusal is asserted against the challenge row as well as the status:
 * a 400 cannot tell "refused before the comparison" from "compared and wrong".
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SeedOptions } from '../helpers/session';
import type { OtpPurpose } from '@app/shared/validation/enums';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  otpChallenges,
  sessions,
  users,
  verificationSessions,
} from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';

import { credentialAccountOf } from '@/lib/auth/credential-account';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { OTP_MAX_CHALLENGE_GUESSES } from '@/lib/otp/limits';
import { REQUESTER_COOKIE, requesterKey } from '@/lib/otp/requester';

import { resetTables } from '../helpers/database';
import { settleDelivery } from '../helpers/mailbox';
import { replaceOtpCode, sentRequester } from '../helpers/otp';
import { resetRateLimits } from '../helpers/rate-limit';
import { baseHeaders, seedUser } from '../helpers/session';

const RIGHT_CODE = '123456';
const WRONG_CODE = '000000';
const NEW_PASSWORD = 'Harness!Reset1';
const UNKNOWN_EMAIL = 'otp.requester.nobody@gmail.com';

function post(path: string, body: unknown, cookie?: string) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        // As a browser sends it: a cookie puts passwordless verify under the
        // library's Origin check.
        origin: PUBLIC_ORIGIN,
        ...(cookie && { cookie }),
      }),
      body: JSON.stringify(body),
    })
  );
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

interface Surface {
  name: string;
  purpose: OtpPurpose;
  seed?: SeedOptions;
  send: (email: string, cookie?: string) => Promise<Response>;
  /** The status alone: no test reads a verify's body. */
  verify: (email: string, code: string, cookie?: string) => Promise<number>;
}

const SURFACES: readonly Surface[] = [
  {
    name: 'contact verification',
    purpose: 'verify_contact',
    seed: { emailVerified: false },
    send: (email, cookie) =>
      post('/api/auth/otp/send', { channel: 'email', email }, cookie),
    verify: (email, code, cookie) =>
      statusOf(
        post('/api/auth/otp/verify', { channel: 'email', email, code }, cookie)
      ),
  },
  {
    name: 'password recovery',
    purpose: 'forgot_password',
    send: (email, cookie) =>
      post(
        '/api/auth/forgot-password/send',
        { channel: 'email', email },
        cookie
      ),
    verify: (email, code, cookie) =>
      statusOf(
        post(
          '/api/auth/forgot-password/reset',
          { channel: 'email', email, code, newPassword: NEW_PASSWORD },
          cookie
        )
      ),
  },
  {
    name: 'passwordless sign-in',
    purpose: 'passwordless_login',
    send: (email, cookie) =>
      post('/api/auth/passwordless/send', { channel: 'email', email }, cookie),
    verify: (email, code, cookie) =>
      statusOf(
        post(
          '/api/auth/passwordless/verify',
          { channel: 'email', email, code },
          cookie
        )
      ),
  },
];

const EACH = SURFACES.map((surface) => [surface.name, surface] as const);

async function challengeOf(userId: string, purpose: OtpPurpose, value: string) {
  const [row] = await db
    .select({ guesses: otpChallenges.guesses })
    .from(otpChallenges)
    .innerJoin(
      verificationSessions,
      eq(verificationSessions.id, otpChallenges.sessionId)
    )
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, purpose),
        eq(otpChallenges.requester, requesterKey(value))
      )
    );
  return row ?? null;
}

async function proofOf(userId: string, purpose: OtpPurpose) {
  const [row] = await db
    .select({
      attemptNumber: verificationSessions.attemptNumber,
      verifyAttemptDaily: verificationSessions.verifyAttemptDaily,
      isBlocked: verificationSessions.isBlocked,
      consumedAt: verificationSessions.consumedAt,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, purpose)
      )
    );
  return row ?? null;
}

/** What a verify that went through would have changed for the user. */
async function accountState(userId: string) {
  const [account] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(credentialAccountOf(userId));
  const [user] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId));
  const live = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return {
    password: account?.password,
    emailVerified: user?.emailVerified,
    sessions: live.length,
  };
}

/** A send from a browser, with the code it was given made known to the test. */
async function sendKnown(
  surface: Surface,
  user: { userId: string; email: string },
  cookie?: string
) {
  const sent = await surface.send(user.email, cookie);
  expect(sent.status).toBe(HTTP_STATUS.OK);
  await settleDelivery();
  const requester = sentRequester(sent);
  await replaceOtpCode({
    userId: user.userId,
    purpose: surface.purpose,
    contactKind: 'email',
    code: RIGHT_CODE,
    requester: requester.requester,
  });
  return requester;
}

beforeEach(async () => {
  await resetTables();
  resetRateLimits();
});

describe('a stranger cannot spend or void the owner’s code', () => {
  test.each(EACH)(
    '%s: another browser’s send and guesses leave it valid',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const owner = await sendKnown(surface, user);

      const stranger = await sendKnown(surface, user);
      expect(stranger.requester).not.toBe(owner.requester);
      for (let guess = 0; guess <= OTP_MAX_CHALLENGE_GUESSES; guess++)
        expect(
          await surface.verify(user.email, WRONG_CODE, stranger.cookie)
        ).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(
        await challengeOf(user.userId, surface.purpose, stranger.requester)
      ).toEqual({ guesses: OTP_MAX_CHALLENGE_GUESSES });

      // The stranger even holds the right code for its own challenge; it is
      // not the owner's, so the owner's row is untouched.
      expect(
        await challengeOf(user.userId, surface.purpose, owner.requester)
      ).toEqual({ guesses: 0 });
      expect(await surface.verify(user.email, RIGHT_CODE, owner.cookie)).toBe(
        HTTP_STATUS.OK
      );
      // Spent with every other browser's code for the same proof.
      expect(
        await challengeOf(user.userId, surface.purpose, stranger.requester)
      ).toBeNull();
    },
    60_000
  );

  test.each(EACH)(
    '%s: a code is redeemable only with the cookie it was sent to',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const owner = await sendKnown(surface, user);

      expect(await surface.verify(user.email, RIGHT_CODE)).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
      const doubled = `${owner.cookie}; ${owner.cookie}`;
      expect(await surface.verify(user.email, RIGHT_CODE, doubled)).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
      // Neither reached the comparison.
      expect(
        await challengeOf(user.userId, surface.purpose, owner.requester)
      ).toEqual({ guesses: 0 });
    },
    60_000
  );
});

describe('each code allows three guesses and nothing outlives it', () => {
  test.each(EACH)(
    '%s: the right code after three wrong ones is refused, and a new code works',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const owner = await sendKnown(surface, user);
      const before = await accountState(user.userId);

      for (let guess = 0; guess < OTP_MAX_CHALLENGE_GUESSES; guess++)
        expect(await surface.verify(user.email, WRONG_CODE, owner.cookie)).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
      expect(await surface.verify(user.email, RIGHT_CODE, owner.cookie)).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
      expect(
        await challengeOf(user.userId, surface.purpose, owner.requester)
      ).toEqual({ guesses: OTP_MAX_CHALLENGE_GUESSES });
      expect(await proofOf(user.userId, surface.purpose)).toMatchObject({
        consumedAt: null,
      });
      // No password written, contact verified or session issued.
      expect(await accountState(user.userId)).toEqual(before);

      // No block or daily count stays behind for the next code, once the
      // resend wait has passed.
      await db
        .update(otpChallenges)
        .set({ nextAllowedAt: new Date() })
        .where(eq(otpChallenges.requester, requesterKey(owner.requester)));
      await sendKnown(surface, user, owner.cookie);
      expect(
        await challengeOf(user.userId, surface.purpose, owner.requester)
      ).toEqual({ guesses: 0 });
      expect(await surface.verify(user.email, RIGHT_CODE, owner.cookie)).toBe(
        HTTP_STATUS.OK
      );
    },
    60_000
  );

  test('concurrent guesses are charged one at a time', async () => {
    const surface = SURFACES[1];
    if (!surface) throw new Error('no recovery surface');
    const user = await seedUser();
    const owner = await sendKnown(surface, user);

    await Promise.all(
      Array.from({ length: OTP_MAX_CHALLENGE_GUESSES * 2 }, () =>
        surface.verify(user.email, WRONG_CODE, owner.cookie)
      )
    );
    expect(
      await challengeOf(user.userId, 'forgot_password', owner.requester)
    ).toEqual({ guesses: OTP_MAX_CHALLENGE_GUESSES });
    expect(await surface.verify(user.email, RIGHT_CODE, owner.cookie)).toBe(
      HTTP_STATUS.BAD_REQUEST
    );
  }, 60_000);
});

describe('strangers cannot exhaust the proof row', () => {
  test.each(EACH)(
    '%s: past the old daily cap and send block, the owner still completes',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      // Fifteen failures and five sends: the old row's daily cap and the send
      // count one short of its six-hour block.
      for (let send = 0; send < 5; send++) {
        const stranger = await sendKnown(surface, user);
        for (let guess = 0; guess < OTP_MAX_CHALLENGE_GUESSES; guess++)
          await surface.verify(user.email, WRONG_CODE, stranger.cookie);
      }
      expect(await proofOf(user.userId, surface.purpose)).toMatchObject({
        attemptNumber: 0,
        verifyAttemptDaily: 0,
        isBlocked: false,
      });

      // The next hour's send quota; the stranger's spend of this one is C-002.
      resetRateLimits();
      const owner = await sendKnown(surface, user);
      expect(await surface.verify(user.email, RIGHT_CODE, owner.cookie)).toBe(
        HTTP_STATUS.OK
      );
    },
    120_000
  );
});

describe('the requester cookie', () => {
  test.each(EACH)(
    '%s: a send answers it alike for an unknown address, and keeps a valid one',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const shape = (response: Response) =>
        response.headers
          .getSetCookie()
          .filter((entry) => entry.startsWith(`${REQUESTER_COOKIE}=`))
          .map((entry) => entry.replace(/^[^;]*/, ''));

      const known = await surface.send(user.email);
      const unknown = await surface.send(UNKNOWN_EMAIL);
      await settleDelivery();
      expect(shape(known)).toHaveLength(1);
      expect(shape(unknown)).toEqual(shape(known));
      expect(shape(known)[0]).toContain('HttpOnly');
      expect(shape(known)[0]).toContain('SameSite=Lax');

      const { cookie, requester } = sentRequester(unknown);
      resetRateLimits();
      const again = await surface.send(user.email, cookie);
      await settleDelivery();
      expect(sentRequester(again).requester).toBe(requester);

      const malformed = await surface.send(
        user.email,
        `${REQUESTER_COOKIE}=not-a-requester`
      );
      await settleDelivery();
      expect(sentRequester(malformed).requester).not.toBe('not-a-requester');
    },
    60_000
  );
});
