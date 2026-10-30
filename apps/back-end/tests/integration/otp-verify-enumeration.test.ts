/**
 * The response an ANONYMOUS verification endpoint gives once a proof row crosses
 * its attempt threshold, compared against the response an address with no account
 * gets for the same request.
 *
 * This is the property the collapse exists for, and it was one-sided. A proof row
 * exists only for a real account, so its throttle is account-dependent:
 * `processOtpVerify` turns the fifth wrong code for an existing proof into a
 * `429` carrying the block message and `Retry-After: 21600`, while an unknown
 * address keeps taking the generic `400`. `POST /api/auth/otp/verify` collapsed
 * that; recovery and passwordless did not — recovery preserves every 429 through
 * its status filter, and passwordless preserves it through `toAuthApiError`. Five
 * CAPTCHA-solvable requests then distinguished an active account by status,
 * header and body, and left the real proof in a six-hour blocked state as a side
 * effect.
 *
 * `collapseProofThrottle` (`lib/otp/throttle.ts`) is the shared fix: `blockedError`
 * marks the error with `OTP_PROOF_THROTTLE_CODE`, and every anonymous boundary
 * collapses THAT KIND rather than collapsing 429 by status — so a pre-lookup
 * IP or destination limiter, which fires for real and fake identifiers alike,
 * still surfaces its own 429 and its own `Retry-After`.
 *
 * Each block below drives the real address to its threshold and then compares
 * exactly one crossing attempt against one unknown-address attempt. That is what
 * the finding is about, and it keeps the cost bounded: every request here pays
 * the endpoint's `MINIMUM_RESPONSE_MS` timing floor.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SeedOptions } from '../helpers/session';
import type { OtpPurpose } from '@app/shared/validation/enums';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { otpChallenges, verificationSessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';

import { PUBLIC_ORIGIN } from '@/lib/env';
import { OTP_MAX_CHALLENGE_GUESSES } from '@/lib/otp/limits';

import { resetTables } from '../helpers/database';
import { settleDelivery } from '../helpers/mailbox';
import { sentRequester } from '../helpers/otp';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

/** Never the code a send issued, so every attempt below is a wrong guess. */
const WRONG_CODE = '000000';
const UNKNOWN_EMAIL = 'otp.enumeration.nobody@gmail.com';
const NEW_PASSWORD = 'Harness!Reset1';

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        // A cookie puts passwordless verify under the library's Origin check.
        origin: PUBLIC_ORIGIN,
        ...(cookie && { cookie }),
      }),
      body: JSON.stringify(body),
    })
  );
}

/** What a caller can actually observe, and therefore what must not differ. */
interface Observed {
  status: number;
  retryAfter: string | null;
  detail: string;
}

async function observe(response: Response): Promise<Observed> {
  const body = (await response.json()) as { detail?: string };
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    detail: body.detail ?? '',
  };
}

interface Surface {
  name: string;
  /**
   * The account state this surface's SEND actually issues a code for.
   *
   * Contact verification needs `emailVerified: false`, and it is the difference
   * between a real test and a vacuous one: `POST /api/auth/otp/send`
   * short-circuits to the generic 200 for an already-verified contact, so with
   * `seedUser()`'s default no code is written, every attempt below answers "no
   * code", and the block passes identically against unfixed code.
   */
  seed?: SeedOptions;
  /** The proof row whose code the loop must actually drive to its threshold. */
  purpose: OtpPurpose;
  send: (email: string) => Promise<Response>;
  /** Always with the requester's cookie: the unknown address gets the same. */
  verify: (email: string, cookie: string) => Promise<Response>;
}

const SURFACES: readonly Surface[] = [
  {
    name: 'contact verification',
    seed: { emailVerified: false },
    purpose: 'verify_contact',
    send: (email) => post('/api/auth/otp/send', { channel: 'email', email }),
    verify: (email, cookie) =>
      post(
        '/api/auth/otp/verify',
        { channel: 'email', email, code: WRONG_CODE },
        cookie
      ),
  },
  {
    name: 'password recovery',
    purpose: 'forgot_password',
    send: (email) =>
      post('/api/auth/forgot-password/send', { channel: 'email', email }),
    verify: (email, cookie) =>
      post(
        '/api/auth/forgot-password/reset',
        {
          channel: 'email',
          email,
          code: WRONG_CODE,
          newPassword: NEW_PASSWORD,
        },
        cookie
      ),
  },
  {
    name: 'passwordless login',
    purpose: 'passwordless_login',
    send: (email) =>
      post('/api/auth/passwordless/send', { channel: 'email', email }),
    verify: (email, cookie) =>
      post(
        '/api/auth/passwordless/verify',
        { channel: 'email', email, code: WRONG_CODE },
        cookie
      ),
  },
];

/** The code this surface's loop was supposed to be charging. */
async function challengeRow(userId: string, purpose: OtpPurpose) {
  const [row] = await db
    .select({ id: otpChallenges.id, guesses: otpChallenges.guesses })
    .from(otpChallenges)
    .innerJoin(
      verificationSessions,
      eq(verificationSessions.id, otpChallenges.sessionId)
    )
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, purpose)
      )
    );
  return row ?? null;
}

/** A real code for `user`, and the cookie its verify must carry. */
async function sendFor(surface: Surface, email: string): Promise<string> {
  const sent = await surface.send(email);
  expect(sent.status).toBe(HTTP_STATUS.OK);
  await settleDelivery();
  return sentRequester(sent).cookie;
}

describe('crossing the code-guess threshold reveals nothing', () => {
  beforeEach(async () => {
    await resetTables();
    // This file's verify and send requests use FIXED-WINDOW keys derived from
    // `TEST_IP`, which persist across files in one `bun test` process. A stale
    // counter from a sibling shows up here as a broken parity assertion
    // rather than as a 429.
    resetSqliteStores();
  });

  test.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    '%s answers the same past the threshold as for an unknown address',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const cookie = await sendFor(surface, user.email);

      // The code has to EXIST before the loop, or every attempt below answers
      // "no code" and the surface proves nothing.
      expect(await challengeRow(user.userId, surface.purpose)).toMatchObject({
        guesses: 0,
      });

      const real: Observed[] = [];
      for (let attempt = 1; attempt <= OTP_MAX_CHALLENGE_GUESSES + 1; attempt++)
        real.push(await observe(await surface.verify(user.email, cookie)));

      // The threshold was actually CROSSED.
      expect(await challengeRow(user.userId, surface.purpose)).toMatchObject({
        guesses: OTP_MAX_CHALLENGE_GUESSES,
      });

      const unknown = await observe(
        await surface.verify(UNKNOWN_EMAIL, cookie)
      );

      // Every attempt, so the answer is constant rather than merely equal at
      // the boundary.
      for (const observed of real) expect(observed).toEqual(unknown);

      // Positively: the generic 400 with no backoff hint, not a 429 that both
      // happen to give.
      expect(unknown.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(unknown.retryAfter).toBeNull();
    },
    120_000
  );
});

/**
 * An `o1:` envelope naming a key generation the keyring no longer holds.
 *
 * `canEvaluateOtp` answers `false` for exactly this and nothing else, and the
 * pair below is why that question exists: `verifyOtpCode` THROWS here — which an
 * operator has to see — but a throw on an anonymous verification path rolls the
 * transaction back into a 500, while an unknown identifier keeps taking the
 * generic 400. Five requests then distinguish a real live proof from a
 * nonexistent account, on a mistimed key rotation, with no credential at all.
 *
 * The key id is well-formed (`KEY_ID_PATTERN`) and the MAC is the right length,
 * so it reaches `getOtpKey` rather than being refused as malformed — a malformed
 * envelope is EVALUABLE and takes the ordinary wrong-code path.
 */
const REMOVED_KEY_HASH = `o1:removedgen:${'A'.repeat(43)}`;

describe('a code hashed under a removed key reveals nothing either', () => {
  beforeEach(async () => {
    await resetTables();
    resetSqliteStores();
  });

  test.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    '%s answers the same as for an unknown address',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const cookie = await sendFor(surface, user.email);

      const row = await challengeRow(user.userId, surface.purpose);
      expect(row).not.toBeNull();

      // The real code, replaced with one no configured key can evaluate.
      // Everything else about the request is unchanged.
      const updated = await db
        .update(otpChallenges)
        .set({ code: REMOVED_KEY_HASH })
        .where(eq(otpChallenges.id, row?.id ?? ''))
        .returning({ id: otpChallenges.id });
      expect(updated).toHaveLength(1);

      const observed = await observe(await surface.verify(user.email, cookie));
      const unknown = await observe(
        await surface.verify(UNKNOWN_EMAIL, cookie)
      );

      expect(observed).toEqual(unknown);
      // Positively: the generic 400, not the 500 the throw used to produce.
      expect(observed.status).toBe(HTTP_STATUS.BAD_REQUEST);
      // And no guess was charged for a code nobody could evaluate.
      expect(await challengeRow(user.userId, surface.purpose)).toMatchObject({
        guesses: 0,
      });
    },
    120_000
  );
});
