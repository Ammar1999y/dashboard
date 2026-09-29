import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';

import { and, eq, gt, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { users, verificationCodes, verificationSessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';

import { auditLog } from '@/lib/audit';

import { logLine } from '@/utils/log';

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
} from './throttle';

/**
 * Errors that represent a code that was actually COMPARED and rejected, as
 * opposed to a request that never reached a comparison.
 *
 * A `WeakSet` rather than another `code` value because `blockedError` already
 * spends `CustomError.code` on the disclosure marker, and both facts have to
 * travel on the same throw. Nothing here reaches the wire.
 *
 * The distinction exists for callers holding a budget of their own — the 2FA
 * challenge's attempts — which must be charged for guesses and refunded for
 * everything else. See `spendChallengeAttempt`.
 */
const evaluatedGuesses = new WeakSet<object>();

function markEvaluatedGuess<E extends object>(error: E): E {
  evaluatedGuesses.add(error);
  return error;
}

/** Did `error` come from a submitted code losing a comparison? */
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
  /**
   * Reason the code was issued. Bound into the locked lookup so a code proven
   * for one purpose cannot be matched against a verify for another.
   */
  purpose: OtpPurpose;
  /**
   * Normalized identifier (email/phone) submitted by the client. Bound into
   * the locked session lookup so a stale session pointing at an old contact
   * can't be matched against a verify for a different one.
   */
  identifier: string;
  code: string;
  /** When provided, OTP-block transitions are audited. */
  auditMeta?: AuditMeta;
  /**
   * Runs inside the same transaction after a match. Receives the matched
   * session's `targetIdentifier` so the committed value comes from the proven
   * row, never from the request body. `verificationSessionId` lets a rotation
   * purge the user's other pending proofs while preserving the one being
   * consumed here.
   */
  onVerified?: (
    tx: Tx,
    matched: { targetIdentifier: string | null; verificationSessionId: string }
  ) => Promise<void>;
}

type VerifyOutcome =
  | { kind: 'matched' }
  | { kind: 'mismatch' }
  | { kind: 'no-code' }
  /**
   * `blockedUntil` travels out of the transaction so the 429 can carry an
   * accurate `Retry-After`. Null only for a row blocked with no expiry, which
   * the writes here never produce; `blockedError` then falls back to the full
   * duration rather than omitting the header.
   */
  | {
      kind: 'blocked';
      blockedUntil: Date | null;
      /** Whether a submitted code was compared before the block was raised. */
      evaluated: boolean;
    };

/**
 * Verifies an OTP code and, on a match, runs `onVerified` atomically with the
 * proof bookkeeping.
 */
export async function processOtpVerify({
  userId,
  userEmail,
  channel,
  purpose,
  identifier,
  code,
  auditMeta,
  onVerified,
}: ProcessOtpVerifyOptions): Promise<void> {
  // What this code proves, independent of how it was delivered. Every lookup
  // and budget below keys on it, so switching sms -> whatsapp reaches the same
  // row rather than a second allowance against the same phone number.
  const contactKind = contactKindOf(channel);

  // The outcome is thrown only AFTER the commit, so the increment and block
  // writes persist; throwing inside withTransaction rolls them back.
  const outcome = await withTransaction<VerifyOutcome>(async (tx) => {
    // `users` FIRST: every flow locks it before `verification_sessions`, and
    // `onVerified` reaches `users` later, so the reverse order here would
    // deadlock against email-change, admin-edit and user-delete.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');

    const [session] = await tx
      .select({
        id: verificationSessions.id,
        isBlocked: verificationSessions.isBlocked,
        blockedUntil: verificationSessions.blockedUntil,
        targetIdentifier: verificationSessions.targetIdentifier,
        // For the audit row: the request's `channel` only has to agree with
        // the contact kind, so it could misreport how the code was delivered.
        channel: verificationSessions.channel,
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
      throw new CustomError(
        'لم يتم إرسال رمز التحقق. يرجى طلب رمز جديد',
        HTTP_STATUS.NOT_FOUND
      );

    // A send-cap block can be set while the verify counters are under their
    // caps; without this, a leftover live code would still verify.
    if (session.isBlocked && session.blockedUntil) {
      // Already locked — no code is looked at, so nothing is charged.
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

    // Read before any counter is charged: a request with no live code cannot
    // be a guess, and charging it would let anyone turn an expired code into a
    // full block that the send path then honours.
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

    // Also before the counters, so a mis-timed key rotation cannot spend a
    // user's budget. See `canEvaluateOtp` for why this is answered as expired.
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
      // Only the FIRST transition into blocked is audited; an already-blocked
      // session would emit a misleading one. Requires userEmail
      // (audit_logs.user_email NOT NULL).
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

    // Stamps a block only on the FIRST transition: re-stamping `blockedUntil`
    // on every later attempt would make it a rolling block an attacker could
    // hold open indefinitely.
    const blockOnce = async (reason: string): Promise<Date | null> => {
      if (session.isBlocked) return session.blockedUntil;
      const blockedUntil = calculateBlockDuration();
      await blockSession(tx, session.id, blockedUntil);
      await auditBlockTransition(reason);
      return blockedUntil;
    };

    const windowExpired = sql`NOW() - ${verificationSessions.verifyAttemptWindowStart} > INTERVAL '24 hours'`;

    // 24h failure budget for THIS proof row. The filter is the row's unique
    // key (ux_verification_sessions_user_contact_purpose), so the SUM reads one
    // row; it is a SUM only to fold an aged-out window to zero in SQL. Scoped
    // to the purpose deliberately: a wider scope would let failed
    // verify_contact attempts deny the victim's forgot_password flow.
    //
    // NOT a rolling window — the row anchors its own 24h period at
    // verifyAttemptWindowStart. Read-then-write is safe: `users` is held FOR
    // UPDATE above, so verifies for this user are serialized.
    const [dailyUsage] = await tx
      .select({
        used: sql<number>`COALESCE(SUM(CASE WHEN ${windowExpired} THEN 0 ELSE ${verificationSessions.verifyAttemptDaily} END), 0)`.mapWith(
          Number
        ),
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.contactKind, contactKind),
          eq(verificationSessions.purpose, purpose)
        )
      );

    const dailyUsed = dailyUsage?.used ?? 0;
    // Budget already spent: the code is never read, so this request cannot be
    // a guess and is not charged.
    if (dailyUsed >= OTP_MAX_DAILY_VERIFY_ATTEMPTS)
      return {
        kind: 'blocked',
        blockedUntil: await blockOnce('daily_cap_reached'),
        evaluated: false,
      };

    // The per-cycle bound stays in the WHERE clause as defense in depth if the
    // row lock is ever removed. The daily bound is NOT here — it is not a
    // property of this row.
    const [bumped] = await tx
      .update(verificationSessions)
      .set({
        verifyAttemptNumber: sql`${verificationSessions.verifyAttemptNumber} + 1`,
        // Reset an EXPIRED anchored window — this does not slide it. If the
        // anchor is older than 24h the counter restarts at 1 from a new anchor;
        // otherwise it increments. So two full budgets can fall inside one
        // moving 24-hour interval, one just before an anchor expires and one
        // just after. That is the accepted limitation, not a rolling window.
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

    // The per-cycle cap was spent before this request; the code is never read.
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

    const matched = await verifyOtpCode(code, activeCode.code);

    if (matched) {
      // onVerified runs first so the sensitive action (e.g. committing the new
      // email + flipping the verified flag) and the proof bookkeeping below
      // commit atomically — there is no verify→action window.
      // No block audit even if shouldBlock fired above: the user never actually
      // got blocked from a usable session.
      if (onVerified)
        await onVerified(tx, {
          targetIdentifier: session.targetIdentifier,
          verificationSessionId: session.id,
        });

      if (purpose === 'verify_contact') {
        // Pure ownership proof — nothing downstream consumes it later.
        await tx
          .delete(verificationSessions)
          .where(eq(verificationSessions.id, session.id));
      } else {
        // Sensitive-action proof (change_email/change_phone, passwordless,
        // forgot_password): keep the row as an auditable single-use record,
        // but drop the code so the same proof can never be replayed. The two
        // writes are sequential rather than `Promise.all`: they share the
        // transaction's one connection, so fanning out only obscures which
        // one failed.
        //
        // The cycle is CLOSED here, so its counters reset:
        //  - `shouldBlock` above may have stamped a block before the code was
        //    even checked. On a correct code the user was never really
        //    blocked, and leaving the flag set would lock the whole
        //    (user, contactKind, purpose) slot for the full block duration.
        //  - attemptNumber/nextAllowedAt are send-cycle state; left in place,
        //    successful passwordless logins would walk the counter to its cap
        //    and the next ordinary login would self-inflict a block.
        //  - verifyAttemptDaily is REFUNDED, not reset. The column counts
        //    FAILED verifies in a 24h anchored window (see db/schema.ts), but
        //    the bound has to be charged before the code can be checked to
        //    stay atomic; the refund is what makes it a failure counter
        //    rather than a daily cap on successful logins. It commits with
        //    this transaction, so unlike an external counter it cannot be
        //    lost. The window is untouched, so resetting the budget still
        //    requires knowing the code.
        //
        // Accepted tradeoff: a user who can complete verifies never accumulates
        // the DB-side SEND throttle. Their remaining bound is the
        // `otp.send.*` limiter chain — the bound moved, it did not disappear.
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

    // A wrong code WAS submitted and checked here, and it crossed a cap. The
    // increment above already charged it — every path that reaches a code
    // comparison charges, and only the ones that never look at a code
    // (`no-code`, already-blocked, budget spent) return before it.
    if (shouldBlock) {
      await auditBlockTransition('threshold_crossed');
      return { kind: 'blocked', blockedUntil: blockUntil, evaluated: true };
    }
    return { kind: 'mismatch' };
  });

  if (outcome.kind === 'matched') return;

  if (outcome.kind === 'no-code')
    throw new CustomError(
      'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد',
      HTTP_STATUS.BAD_REQUEST
    );
  if (outcome.kind === 'blocked') {
    // The message says a new code lifts the block: see
    // `VERIFY_BLOCK_CLEARED_BY_RESEND`.
    const blocked = blockedError(
      'تم حظر التحقق مؤقتاً بعد تجاوز عدد المحاولات. يرجى طلب رمز جديد',
      outcome.blockedUntil
    );
    throw outcome.evaluated ? markEvaluatedGuess(blocked) : blocked;
  }
  throw markEvaluatedGuess(
    new CustomError('رمز التحقق غير صحيح', HTTP_STATUS.BAD_REQUEST)
  );
}

type OtpMatch = Parameters<
  NonNullable<ProcessOtpVerifyOptions['onVerified']>
>[1];

/**
 * `processOtpVerify`, or under OTP_AUTO_VERIFY `onVerified` alone in a fresh
 * transaction. `matched` is then `null`: no proof was consumed, so the request
 * body is the only source for what to commit.
 */
export function verifyOtpOrAutoVerify(
  opts: Omit<ProcessOtpVerifyOptions, 'onVerified'> & {
    onVerified: (tx: Tx, matched: OtpMatch | null) => Promise<void>;
  }
): Promise<void> {
  return OTP_AUTO_VERIFY
    ? withTransaction((tx) => opts.onVerified(tx, null))
    : processOtpVerify(opts);
}
