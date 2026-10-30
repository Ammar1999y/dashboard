/**
 * A live OTP proof written straight into the tables, hashed by the production
 * helper. An anonymous purpose's code is bound to a fresh requester, whose
 * cookie the verify must carry.
 *
 * Direct SQL rather than a send request: the send path defers delivery and never
 * returns the code it issued, so a test that goes through it cannot present the
 * right one. `hashOtpCode` is the same envelope the real send writes, so the
 * verify path is exercised for real.
 */
import type {
  ContactKind,
  OtpChannel,
  OtpPurpose,
} from '@app/shared/validation/enums';

import { and, eq, gt } from 'drizzle-orm';

import { db } from '@/db';
import {
  otpChallenges,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';

import { OTP_EXPIRY_MINUTES } from '@app/shared/validation/constants';

import { randomToken } from '@/lib/auth/verifications';
import { MINIMUM_RESPONSE_MS } from '@/lib/http/timing-floor';
import { hashOtpCode } from '@/lib/otp/hash';
import { REQUESTER_COOKIE, requesterKey } from '@/lib/otp/requester';
import { isFlatResendPurpose } from '@/lib/otp/throttle';

import { assertHarnessDatabase } from './database';

/** Room for `calls` responses held to the anonymous timing floor, and one more floor for the rest. */
export const flooredBudget = (calls: number) =>
  (calls + 1) * MINIMUM_RESPONSE_MS;

export interface SeededOtpProof {
  sessionId: string;
  code: string;
  /** The `Cookie` header an anonymous purpose's verify must send; empty otherwise. */
  cookie: string;
}

/** The requester a real send answered, as its id and a request `Cookie` header. */
export function sentRequester(response: Response): {
  requester: string;
  cookie: string;
} {
  const line = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${REQUESTER_COOKIE}=`));
  const cookie = line?.split(';', 1)[0];
  if (!cookie) throw new Error('the send set no requester cookie');
  return { requester: cookie.slice(REQUESTER_COOKIE.length + 1), cookie };
}

/** A requester id and the `Cookie` header that carries it. */
export function otpRequester(): { requester: string; cookie: string } {
  const requester = randomToken(32);
  return { requester, cookie: `${REQUESTER_COOKIE}=${requester}` };
}

const liveCode = (code: string) => ({
  code: hashOtpCode(code),
  expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
});

/** An anonymous purpose's code for `requester`, as a send writes one. */
async function bindChallenge(
  sessionId: string,
  requester: string,
  code: string
): Promise<void> {
  await db.insert(otpChallenges).values({
    sessionId,
    requester: requesterKey(requester),
    ...liveCode(code),
    nextAllowedAt: new Date(),
  });
}

/**
 * The code a real send bound to `requester`, and nothing else about it: a send
 * that wrote no row, or wrote it for another requester or already expired,
 * fails here instead of being repaired.
 */
async function replaceChallengeCode(
  sessionId: string,
  requester: string,
  code: string
): Promise<void> {
  const replaced = await db
    .update(otpChallenges)
    .set({ code: hashOtpCode(code) })
    .where(
      and(
        eq(otpChallenges.sessionId, sessionId),
        eq(otpChallenges.requester, requesterKey(requester)),
        gt(otpChallenges.expiresAt, new Date())
      )
    )
    .returning({ id: otpChallenges.id });
  if (replaced.length !== 1)
    throw new Error('the send bound no live code to this requester');
}

export async function seedOtpProof(options: {
  userId: string;
  identifier: string;
  purpose: OtpPurpose;
  code: string;
  channel?: OtpChannel;
  targetIdentifier?: string;
  /** Anonymous purposes only; a fresh one when absent. */
  requester?: string;
}): Promise<SeededOtpProof> {
  await assertHarnessDatabase();

  const [row] = await db
    .insert(verificationSessions)
    .values({
      userId: options.userId,
      channel: options.channel ?? 'email',
      identifier: options.identifier,
      targetIdentifier: options.targetIdentifier,
      purpose: options.purpose,
      attemptNumber: 1,
    })
    .returning({ id: verificationSessions.id });
  if (!row) throw new Error('seedOtpProof inserted no session');

  if (!isFlatResendPurpose(options.purpose)) {
    await db
      .insert(verificationCodes)
      .values({ sessionId: row.id, ...liveCode(options.code) });
    return { sessionId: row.id, code: options.code, cookie: '' };
  }

  const bound = options.requester
    ? {
        requester: options.requester,
        cookie: `${REQUESTER_COOKIE}=${options.requester}`,
      }
    : otpRequester();
  await bindChallenge(row.id, bound.requester, options.code);
  return { sessionId: row.id, code: options.code, cookie: bound.cookie };
}

/**
 * A new code on the proof row a real send already created, as a resend writes
 * one. The row carries the purpose binding and the counters a test asserts, so
 * only the code is replaced. An anonymous purpose's code is the one the send
 * bound to `requester`.
 */
export async function replaceOtpCode(options: {
  userId: string;
  purpose: OtpPurpose;
  contactKind: ContactKind;
  code: string;
  requester?: string;
}): Promise<void> {
  await assertHarnessDatabase();
  const [proof] = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, options.userId),
        eq(verificationSessions.purpose, options.purpose),
        eq(verificationSessions.contactKind, options.contactKind)
      )
    );
  if (!proof)
    throw new Error(`no ${options.purpose}/${options.contactKind} proof row`);
  if (isFlatResendPurpose(options.purpose)) {
    if (!options.requester)
      throw new Error(`${options.purpose} codes are bound to a requester`);
    await replaceChallengeCode(proof.id, options.requester, options.code);
    return;
  }
  const code = liveCode(options.code);
  await db
    .insert(verificationCodes)
    .values({ sessionId: proof.id, ...code })
    .onConflictDoUpdate({ target: verificationCodes.sessionId, set: code });
}
