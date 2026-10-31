/**
 * Codes for the purposes anyone can request by naming a contact, bound to the
 * browser that asked (`./requester.ts`). Each requester spends only its own
 * code: a stranger's sends cannot void the owner's, and a stranger's guesses
 * cannot block it. There is no daily cap behind the per-code guesses; the
 * per-destination send quota is what bounds the total.
 */
import type { FlatResendPurpose } from './throttle';
import type {
  OtpMatch,
  ProcessOtpVerifyOptions,
  VerifyOutcome,
} from './verify';
import type { Executor, Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';

import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { otpChallenges, verificationSessions } from '@/db/schema';

import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';

import { generateUuidV7 } from '@/lib/id';
import { enforceOtpGlobalSendBudget } from '@/lib/rate-limit';
import { lockUser } from '@/lib/users/lock-order';

import { logLine } from '@/utils/log';

import { canEvaluateOtp, hashOtpCode, verifyOtpCode } from './hash';
import { OTP_MAX_CHALLENGE_GUESSES } from './limits';
import { requesterKey } from './requester';
import { calculateOtpExpiry, deliverOrRefund, generateOtpCode } from './send';
import { calculateNextAllowedAt, resendWaitError } from './throttle';
import { consumeProof, settleVerifyOutcome, transactionWithin } from './verify';

export async function sendRequesterOtp(options: {
  userId: EntityID;
  /** Normalised; verify must present the same value. */
  identifier: string;
  channel: OtpChannel;
  purpose: FlatResendPurpose;
  requester: string;
  deferDelivery: (task: () => Promise<void>) => void;
}): Promise<void> {
  const { userId, identifier, channel, purpose, requester, deferDelivery } =
    options;
  const code = generateOtpCode();
  const hashedCode = hashOtpCode(code);
  // Before the lock: a send admitted by this hour's quota must not wait into a
  // later hour and live there, past the bound the quota sets.
  const expiresAt = calculateOtpExpiry();

  const challengeId = await withTransaction(async (tx) => {
    // The lock `processOtpSend` takes, for the reasons it gives.
    await lockUser(tx, userId, 'no key update');
    const now = new Date();

    // The proof row keeps no send or guess state for these purposes: whatever a
    // release before this one left there is ignored, not cleared.
    const [proof] = await tx
      .insert(verificationSessions)
      .values({ userId, channel, identifier, purpose, lastSentAt: now })
      .onConflictDoUpdate({
        target: [
          verificationSessions.userId,
          verificationSessions.contactKind,
          verificationSessions.purpose,
        ],
        // Reopened, or the retention sweep would take a consumed row and its
        // new code with it.
        set: {
          channel,
          identifier,
          verifiedAt: null,
          consumedAt: null,
          lastSentAt: now,
        },
      })
      .returning({ id: verificationSessions.id });
    if (!proof)
      throw new CustomError(otpMsg.sendError, HTTP_STATUS.INTERNAL_ERROR);

    const key = requesterKey(requester);
    const [held] = await tx
      .select({ nextAllowedAt: otpChallenges.nextAllowedAt })
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.sessionId, proof.id),
          eq(otpChallenges.requester, key)
        )
      )
      .for('update');
    if (held && held.nextAllowedAt > now)
      throw resendWaitError(held.nextAllowedAt, now);

    // A new id per issuance: the refund below matches its own issuance, and a
    // resend can draw the same six digits.
    const fresh = {
      id: generateUuidV7(),
      code: hashedCode,
      expiresAt,
      guesses: 0,
      nextAllowedAt: calculateNextAllowedAt(1, purpose),
    };
    const [challenge] = await tx
      .insert(otpChallenges)
      .values({ sessionId: proof.id, requester: key, ...fresh })
      .onConflictDoUpdate({
        target: [otpChallenges.sessionId, otpChallenges.requester],
        set: fresh,
      })
      .returning({ id: otpChallenges.id });
    if (!challenge)
      throw new CustomError(otpMsg.sendError, HTTP_STATUS.INTERNAL_ERROR);

    // Last, as in `processOtpSend`: a rejection rolls back the stored code.
    await enforceOtpGlobalSendBudget({ channel });
    return challenge.id;
  });

  await deliverOrRefund({
    channel,
    sendTo: identifier,
    code,
    purpose,
    deferDelivery,
    // Frees the requester to resend at once. A verify holds the user before
    // this row, and this holds nothing else, so the two cannot deadlock.
    refund: async () => {
      await db.delete(otpChallenges).where(eq(otpChallenges.id, challengeId));
    },
  });
}

type RequesterVerifyOptions = Omit<
  ProcessOtpVerifyOptions,
  'auditMeta' | 'userEmail' | 'purpose'
> & {
  purpose: FlatResendPurpose;
  /** `null` when the browser sent none: answered as a code never sent. */
  requester: string | null;
};

function requesterChallenge(
  executor: Executor,
  options: RequesterVerifyOptions & { requester: string }
) {
  const { userId, channel, purpose, identifier, requester } = options;
  return executor
    .select({
      sessionId: verificationSessions.id,
      targetIdentifier: verificationSessions.targetIdentifier,
      challengeId: otpChallenges.id,
      code: otpChallenges.code,
    })
    .from(verificationSessions)
    .innerJoin(
      otpChallenges,
      and(
        eq(otpChallenges.sessionId, verificationSessions.id),
        eq(otpChallenges.requester, requesterKey(requester)),
        // Built per read, not `now()`: that is the transaction's start, and the
        // second read follows a lock wait.
        gt(otpChallenges.expiresAt, new Date())
      )
    )
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.contactKind, contactKindOf(channel)),
        eq(verificationSessions.purpose, purpose),
        eq(verificationSessions.identifier, identifier)
      )
    )
    .limit(1);
}

export async function verifyRequesterOtp(
  options: RequesterVerifyOptions
): Promise<void> {
  const { requester, purpose, code, onVerified } = options;
  if (requester === null) return settleVerifyOutcome({ kind: 'no-code' });

  // In the transaction for its deadline: only a real account reaches here, so
  // an unbounded wait for a connection would say which accounts exist.
  const outcome = await transactionWithin<VerifyOutcome>(async (tx) => {
    // Unlocked first: a guess with no code of its own must not queue on the
    // owner's user lock, which nothing else here would bound.
    const [held] = await requesterChallenge(tx, { ...options, requester });
    if (!held) return { kind: 'no-code' };

    // `users` before the row lock below: the canonical order, and
    // `onVerified` reaches it.
    await lockUser(tx, options.userId);

    const [challenge] = await requesterChallenge(tx, {
      ...options,
      requester,
    });
    if (!challenge) return { kind: 'no-code' };

    // Before the charge, so a mis-timed key rotation spends no guess.
    if (!canEvaluateOtp(challenge.code)) {
      logLine('error', {
        msg: 'otp.verify.keyUnavailable',
        effect: 'live codes under a retired key cannot be verified',
        purpose,
        contactKind: contactKindOf(options.channel),
      });
      return { kind: 'no-code' };
    }

    // ⚠️ The brute-force bound: the comparison below is reached only through
    // this charge, and the WHERE refuses a fourth even if the lock goes.
    const [charged] = await tx
      .update(otpChallenges)
      .set({ guesses: sql`${otpChallenges.guesses} + 1` })
      .where(
        and(
          eq(otpChallenges.id, challenge.challengeId),
          lt(otpChallenges.guesses, OTP_MAX_CHALLENGE_GUESSES),
          gt(otpChallenges.expiresAt, new Date())
        )
      )
      .returning({ guesses: otpChallenges.guesses });
    if (!charged)
      return { kind: 'blocked', blockedUntil: null, evaluated: false };

    if (await verifyOtpCode(code, challenge.code)) {
      if (onVerified)
        await onVerified(tx, {
          targetIdentifier: challenge.targetIdentifier,
          verificationSessionId: challenge.sessionId,
        });
      await consumeProof(tx, challenge.sessionId, purpose);
      return { kind: 'matched' };
    }

    return charged.guesses >= OTP_MAX_CHALLENGE_GUESSES
      ? { kind: 'blocked', blockedUntil: null, evaluated: true }
      : { kind: 'mismatch' };
  }, options);

  settleVerifyOutcome(outcome);
}

/** Under `OTP_AUTO_VERIFY`, `matched` is `null`: no proof row was consumed. */
export function verifyRequesterOtpOrAutoVerify(
  options: Omit<RequesterVerifyOptions, 'onVerified'> & {
    onVerified: (tx: Tx, matched: OtpMatch | null) => Promise<void>;
  }
): Promise<void> {
  return OTP_AUTO_VERIFY
    ? transactionWithin((tx) => options.onVerified(tx, null), options)
    : verifyRequesterOtp(options);
}
