import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';

import { and, eq, gt, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { users, verificationCodes, verificationSessions } from '@/db/schema';
import { TransactionDeadlineError } from '@/db/transaction';

import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import { contactKindOf } from '@app/shared/validation/enums';

import { auditLog } from '@/lib/audit';

import { logLine, logSanitized } from '@/utils/log';

import { canEvaluateOtp, verifyOtpCode } from './hash';
import {
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
} from './limits';
import {
  BLOCK_EXPIRY_RESET,
  blockedError,
  blockSession,
  calculateBlockDuration,
  invalidOrExpiredCode,
} from './throttle';

/**
 * Throws from a code that was actually compared, for callers with their own
 * budget (`spendChallengeAttempt`). A `WeakSet` because `blockedError` already
 * spends `CustomError.code` on the disclosure marker.
 */
const evaluatedGuesses = new WeakSet<object>();

function markEvaluatedGuess<E extends object>(error: E): E {
  evaluatedGuesses.add(error);
  return error;
}

export function otpGuessWasEvaluated(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && evaluatedGuesses.has(error)
  );
}

interface ProcessOtpVerifyOptions {
  userId: EntityID;
  /** Required with `auditMeta`: the block transition's audit row needs it. */
  userEmail?: string;
  /** Only has to agree with the proof's contact kind. */
  channel: OtpChannel;
  purpose: OtpPurpose;
  /** Normalised; bound into the lookup so a proof for an old contact cannot match. */
  identifier: string;
  code: string;
  auditMeta?: AuditMeta;
  /**
   * Anonymous callers only: a floor deadline (`floorDeadline`) the transaction
   * may not outlast, its wait for a connection and every statement included.
   * Past it nothing is committed and the answer is the unknown identifier's.
   */
  deadline?: number;
  /**
   * Runs in the same transaction after a match. Commit `targetIdentifier` from
   * the proven row, never the request body.
   */
  onVerified?: (
    tx: Tx,
    matched: { targetIdentifier: string | null; verificationSessionId: string }
  ) => Promise<void>;
}

async function transactionWithin<T>(
  fn: (tx: Tx) => Promise<T>,
  { deadline, purpose }: Pick<ProcessOtpVerifyOptions, 'deadline' | 'purpose'>
): Promise<T> {
  const started = Date.now();
  try {
    return await withTransaction(fn, undefined, deadline);
  } catch (error) {
    if (!(error instanceof TransactionDeadlineError)) throw error;
    // The answer hides whether the code was right, so this line is the only
    // trace that a correct one may have been refused.
    logSanitized('error', {
      msg: 'otp.verify.deadlineExceeded',
      purpose,
      elapsedMs: Date.now() - started,
      error,
    });
    const refusal = invalidOrExpiredCode();
    refusal.cause = error;
    throw refusal;
  }
}

type VerifyOutcome =
  | { kind: 'matched' }
  | { kind: 'mismatch' }
  | { kind: 'no-code' }
  | {
      kind: 'blocked';
      blockedUntil: Date | null;
      /** Whether a submitted code was compared before the block was raised. */
      evaluated: boolean;
    };

export async function processOtpVerify(
  options: ProcessOtpVerifyOptions
): Promise<void> {
  const {
    userId,
    userEmail,
    channel,
    purpose,
    identifier,
    code,
    auditMeta,
    onVerified,
  } = options;
  // Keyed on contact kind, so switching sms -> whatsapp buys no second allowance.
  const contactKind = contactKindOf(channel);

  // Thrown only after the commit, so the counter and block writes persist.
  const outcome = await transactionWithin<VerifyOutcome>(async (tx) => {
    // `users` first: the canonical lock order, and `onVerified` reaches it.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');

    const windowExpired = sql`NOW() - ${verificationSessions.verifyAttemptWindowStart} > INTERVAL '24 hours'`;

    const [session] = await tx
      .select({
        id: verificationSessions.id,
        isBlocked: verificationSessions.isBlocked,
        blockedUntil: verificationSessions.blockedUntil,
        targetIdentifier: verificationSessions.targetIdentifier,
        // For the audit row: the request's `channel` may misreport delivery.
        channel: verificationSessions.channel,
        // Zero once the window has aged out. Per purpose on purpose: wider,
        // failed verify_contact attempts would deny forgot_password.
        // Read-then-write is safe under the `users` lock, and nothing below
        // touches the counter before its charge.
        dailyUsed:
          sql<number>`CASE WHEN ${windowExpired} THEN 0 ELSE ${verificationSessions.verifyAttemptDaily} END`.mapWith(
            Number
          ),
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.contactKind, contactKind),
          eq(verificationSessions.purpose, purpose),
          eq(verificationSessions.identifier, identifier)
        )
      )
      .for('update');

    if (!session)
      throw new CustomError(otpMsg.codeNotSent, HTTP_STATUS.NOT_FOUND);

    // A send-cap block can be set while the verify counters are under their
    // caps; without this, a leftover live code would still verify.
    if (session.isBlocked && session.blockedUntil) {
      if (session.blockedUntil > new Date())
        return {
          kind: 'blocked',
          blockedUntil: session.blockedUntil,
          evaluated: false,
        };

      await tx
        .update(verificationSessions)
        .set(BLOCK_EXPIRY_RESET)
        .where(eq(verificationSessions.id, session.id));
      session.isBlocked = false;
    }

    // Before any charge: otherwise anyone could turn an expired code into a
    // block the send path honours.
    const [activeCode] = await tx
      .select({
        id: verificationCodes.id,
        code: verificationCodes.code,
      })
      .from(verificationCodes)
      .where(
        and(
          eq(verificationCodes.sessionId, session.id),
          gt(verificationCodes.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!activeCode) return { kind: 'no-code' };

    // Before the counters, so a mis-timed key rotation spends no budget.
    if (!canEvaluateOtp(activeCode.code)) {
      // No identifier: the retired key id is in the stored envelopes.
      logLine('error', {
        msg: 'otp.verify.keyUnavailable',
        effect: 'live codes under a retired key cannot be verified',
        purpose,
        contactKind,
      });
      return { kind: 'no-code' };
    }

    const auditBlockTransition = async (reason: string) => {
      // First transition only. `audit_logs.user_email` is NOT NULL.
      if (!auditMeta || !userEmail || session.isBlocked) return;
      await auditLog(tx, {
        userId,
        userEmail,
        action: 'UPDATE',
        tableName: 'verification_sessions',
        recordId: session.id,
        oldData: { isBlocked: false },
        newData: { isBlocked: true, channel: session.channel, reason },
        meta: auditMeta,
      });
    };

    // Re-stamping would make a rolling block an attacker holds open forever.
    const blockOnce = async (reason: string): Promise<Date | null> => {
      if (session.isBlocked) return session.blockedUntil;
      const blockedUntil = calculateBlockDuration();
      await blockSession(tx, session.id, blockedUntil);
      await auditBlockTransition(reason);
      return blockedUntil;
    };

    const { dailyUsed } = session;
    if (dailyUsed >= OTP_MAX_DAILY_VERIFY_ATTEMPTS)
      return {
        kind: 'blocked',
        blockedUntil: await blockOnce('daily_cap_reached'),
        evaluated: false,
      };

    // The per-cycle bound in the WHERE is defence in depth if the lock goes.
    const [bumped] = await tx
      .update(verificationSessions)
      .set({
        verifyAttemptNumber: sql`${verificationSessions.verifyAttemptNumber} + 1`,
        // Anchored, not rolling: two full budgets can straddle an anchor's
        // expiry. Accepted.
        verifyAttemptDaily: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${verificationSessions.verifyAttemptDaily} + 1 END`,
        verifyAttemptWindowStart: sql`CASE WHEN ${windowExpired} THEN NOW() ELSE ${verificationSessions.verifyAttemptWindowStart} END`,
      })
      .where(
        and(
          eq(verificationSessions.id, session.id),
          sql`${verificationSessions.verifyAttemptNumber} < ${OTP_MAX_VERIFY_ATTEMPTS}`
        )
      )
      .returning({
        verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      });

    if (!bumped)
      return {
        kind: 'blocked',
        blockedUntil: await blockOnce('cap_reached'),
        evaluated: false,
      };

    const shouldBlock =
      bumped.verifyAttemptNumber >= OTP_MAX_VERIFY_ATTEMPTS ||
      dailyUsed + 1 >= OTP_MAX_DAILY_VERIFY_ATTEMPTS;
    const blockUntil = shouldBlock ? calculateBlockDuration() : null;
    if (blockUntil) await blockSession(tx, session.id, blockUntil);

    // ⚠️ The brute-force bound: every path that reaches this comparison has
    // been charged above; only those that never read a code return earlier.
    const matched = await verifyOtpCode(code, activeCode.code);

    if (matched) {
      // No block audit even if `shouldBlock` fired: a correct code was never blocked.
      if (onVerified)
        await onVerified(tx, {
          targetIdentifier: session.targetIdentifier,
          verificationSessionId: session.id,
        });

      if (purpose === 'verify_contact') {
        await tx
          .delete(verificationSessions)
          .where(eq(verificationSessions.id, session.id));
      } else {
        // Kept as an auditable single-use record; the code is dropped. The
        // cycle closes, so its counters reset: a block stamped before the
        // compare would lock the slot, and leftover send state would walk
        // repeat logins into a self-inflicted block. `verifyAttemptDaily` is
        // REFUNDED, not reset, which keeps it a failure counter. Accepted: a
        // user who completes verifies is bounded by `otp.send.*` only.
        await tx
          .update(verificationSessions)
          .set({
            verifiedAt: sql`now()`,
            consumedAt: sql`now()`,
            isBlocked: false,
            blockedUntil: null,
            attemptNumber: 0,
            verifyAttemptNumber: 0,
            verifyAttemptDaily: sql`GREATEST(${verificationSessions.verifyAttemptDaily} - 1, 0)`,
            nextAllowedAt: null,
          })
          .where(eq(verificationSessions.id, session.id));

        await tx
          .delete(verificationCodes)
          .where(eq(verificationCodes.sessionId, session.id));
      }
      return { kind: 'matched' };
    }

    if (shouldBlock) {
      await auditBlockTransition('threshold_crossed');
      return { kind: 'blocked', blockedUntil: blockUntil, evaluated: true };
    }
    return { kind: 'mismatch' };
  }, options);

  if (outcome.kind === 'matched') return;

  if (outcome.kind === 'no-code')
    throw new CustomError(otpMsg.codeExpired, HTTP_STATUS.BAD_REQUEST);
  if (outcome.kind === 'blocked') {
    const blocked = blockedError(otpMsg.verifyBlocked, outcome.blockedUntil);
    throw outcome.evaluated ? markEvaluatedGuess(blocked) : blocked;
  }
  throw markEvaluatedGuess(
    new CustomError(otpMsg.codeIncorrect, HTTP_STATUS.BAD_REQUEST)
  );
}

type OtpMatch = Parameters<
  NonNullable<ProcessOtpVerifyOptions['onVerified']>
>[1];

/** Under `OTP_AUTO_VERIFY`, `matched` is `null`: no proof row was consumed. */
export function verifyOtpOrAutoVerify(
  opts: Omit<ProcessOtpVerifyOptions, 'onVerified'> & {
    onVerified: (tx: Tx, matched: OtpMatch | null) => Promise<void>;
  }
): Promise<void> {
  return OTP_AUTO_VERIFY
    ? transactionWithin((tx) => opts.onVerified(tx, null), opts)
    : processOtpVerify(opts);
}
