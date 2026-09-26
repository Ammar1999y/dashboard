import crypto from 'node:crypto';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { verificationCodes, verificationSessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { OTP_EXPIRY_MINUTES } from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';

import { enforceOtpGlobalSendBudget } from '@/lib/rate-limit';

import { sanitizeForLog } from '@/utils/log';

import { deliverOtp, MSG_OTP_SEND_FAILED } from './delivery';
import { hashOtpCode } from './hash';
import { OTP_BLOCK_DURATION_HOURS, OTP_MAX_ATTEMPTS } from './limits';
import {
  BLOCK_EXPIRY_RESET,
  blockedError,
  blockSession,
  calculateBlockDuration,
  calculateNextAllowedAt,
  VERIFY_BLOCK_CLEARED_BY_RESEND,
} from './throttle';

function generateOtpCode() {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

function calculateOtpExpiry(): Date {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
}

interface ProcessOtpSendOptions {
  userId: EntityID;
  /** The normalized contact the proof is bound to; verify must present the same value. */
  identifier: string;
  channel: OtpChannel;
  /**
   * Reason the code is being issued. Bound into the session so a code proven
   * for one purpose can never authorize a different sensitive action.
   */
  purpose: OtpPurpose;
  /**
   * For contact-change purposes (change_email/change_phone): the NEW contact
   * whose ownership is being proven. Persisted so verify can commit exactly
   * that value. Must be null for every other purpose.
   */
  targetIdentifier?: string | null;
  /** The phone number or email the code is delivered to. */
  sendTo: string;
  /** Localized entity label used in error messages */
  entityName: string;
  /**
   * Hands the provider call to the caller to run AFTER its response is on the
   * wire; without it the delivery is awaited inline and its failure thrown.
   *
   * **The anonymous send endpoints must pass it: it is what stops them being an
   * existence oracle.** `ensureMinDelay` is a floor with no ceiling, so a
   * provider call on the response path makes any response above the floor proof
   * that the real branch ran — and no floor can exceed an unbounded third-party
   * call. Off the path, a slow provider also cannot hit the route's idle timeout
   * or hold `app.stop()` open during a deploy.
   */
  deferDelivery?: (task: () => Promise<void>) => void;
}

interface ProcessOtpSendResult {
  nextAllowedIn: number;
  attemptsRemaining: number;
}

async function refundFailedDelivery(
  sessionId: EntityID,
  hashedCode: string
): Promise<void> {
  await withTransaction(async (tx) => {
    const [removed] = await tx
      .delete(verificationCodes)
      .where(
        and(
          eq(verificationCodes.sessionId, sessionId),
          eq(verificationCodes.code, hashedCode)
        )
      )
      .returning({ id: verificationCodes.id });
    if (!removed) return;
    await tx
      .update(verificationSessions)
      .set({
        attemptNumber: sql`GREATEST(${verificationSessions.attemptNumber} - 1, 0)`,
        nextAllowedAt: null,
      })
      .where(eq(verificationSessions.id, sessionId));
  });
}

/**
 * Rate-limits, stores and delivers one code. Storage is a single transaction
 * under row locks; delivery runs after it commits.
 */
export async function processOtpSend({
  userId,
  identifier,
  channel,
  purpose,
  targetIdentifier = null,
  sendTo,
  entityName,
  deferDelivery,
}: ProcessOtpSendOptions): Promise<ProcessOtpSendResult> {
  // The session row is keyed on what is being proven, not on the transport.
  const contactKind = contactKindOf(channel);

  // Before the locks: no work that can run earlier should run under a row lock.
  const otpCode = generateOtpCode();
  const hashedCode = hashOtpCode(otpCode);

  // Thrown after the commit, so the max-attempts block persists.
  let deferredError: CustomError | null = null;

  const result = await withTransaction(async (tx) => {
    // Serializes concurrent sends for one row: FOR UPDATE locks nothing while
    // the row does not exist yet, so two first sends would both INSERT. The
    // two-argument form gives a 64-bit keyspace. Keyed on the contact KIND,
    // matching the unique index, so an sms and a whatsapp send for one phone
    // take the same lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${contactKind} || ':' || ${purpose}))`
    );

    const now = new Date();
    let [session] = await tx
      .select({
        id: verificationSessions.id,
        attemptNumber: verificationSessions.attemptNumber,
        isBlocked: verificationSessions.isBlocked,
        blockedUntil: verificationSessions.blockedUntil,
        nextAllowedAt: verificationSessions.nextAllowedAt,
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.contactKind, contactKind),
          eq(verificationSessions.purpose, purpose)
        )
      )
      .for('update');

    // Captured BEFORE the clear below, so the max-attempts branch can preserve
    // an existing send-side deadline instead of minting a new one.
    const existingBlockedUntil = session?.isBlocked
      ? session.blockedUntil
      : null;

    // A live block is CLEARED here, not thrown on — see
    // `VERIFY_BLOCK_CLEARED_BY_RESEND` for why that does not weaken anything.
    if (session?.isBlocked && session.blockedUntil) {
      const [unblocked] = await tx
        .update(verificationSessions)
        .set(
          session.blockedUntil > now
            ? VERIFY_BLOCK_CLEARED_BY_RESEND
            : BLOCK_EXPIRY_RESET
        )
        .where(eq(verificationSessions.id, session.id))
        .returning({
          id: verificationSessions.id,
          attemptNumber: verificationSessions.attemptNumber,
          isBlocked: verificationSessions.isBlocked,
          blockedUntil: verificationSessions.blockedUntil,
          nextAllowedAt: verificationSessions.nextAllowedAt,
        });
      session = unblocked;
    }

    if (session?.nextAllowedAt && session.nextAllowedAt > now) {
      const waitSeconds = Math.ceil(
        (session.nextAllowedAt.getTime() - now.getTime()) / 1000
      );
      throw new CustomError(
        `يرجى الانتظار ${waitSeconds} ثانية قبل إعادة الإرسال`,
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    // Checked before the increment, which `chk_attempt_number_max` would
    // otherwise refuse as a raw constraint error. The throw is deferred so the
    // block update COMMITS: throwing inside withTransaction rolls it back.
    if (session && session.attemptNumber >= OTP_MAX_ATTEMPTS) {
      // Stamped ONCE and then preserved: re-deriving it per request would turn
      // the penalty into a rolling one anyone who knows the identifier can
      // extend. `session.isBlocked` cannot be the guard, as it is on the verify
      // side — the clear above has always reset it by now.
      const blockedUntil =
        existingBlockedUntil && existingBlockedUntil > now
          ? existingBlockedUntil
          : calculateBlockDuration();
      await blockSession(tx, session.id, blockedUntil);

      deferredError = blockedError(
        `تجاوزت الحد الأقصى من المحاولات. تم حظر ${entityName} لمدة ${OTP_BLOCK_DURATION_HOURS} ساعة`,
        blockedUntil
      );
      return null;
    }

    const expiresAt = calculateOtpExpiry();

    const currentAttempts = session?.attemptNumber ?? 0;
    const nextAllowedAt = calculateNextAllowedAt(currentAttempts + 1, purpose);

    // A resend resets the per-cycle `verifyAttemptNumber` but leaves
    // `verifyAttemptDaily` and its window alone, so requesting a fresh code
    // cannot reset the 24h bound.
    const [updatedSession] = await tx
      .insert(verificationSessions)
      .values({
        userId,
        channel,
        identifier,
        purpose,
        targetIdentifier,
        attemptNumber: 1,
        verifyAttemptNumber: 0,
        lastSentAt: now,
        nextAllowedAt,
      })
      .onConflictDoUpdate({
        // Must match ux_verification_sessions_user_contact_purpose — otherwise a
        // change_email send would clobber an in-flight verify_contact code.
        target: [
          verificationSessions.userId,
          verificationSessions.contactKind,
          verificationSessions.purpose,
        ],
        set: {
          // The transport can change between resends (sms -> whatsapp) while the
          // row stays the same; record the one actually used.
          channel,
          identifier,
          targetIdentifier,
          attemptNumber: sql`${verificationSessions.attemptNumber} + 1`,
          verifyAttemptNumber: 0,
          // A fresh code voids any prior proof for this (user, contact, purpose).
          verifiedAt: null,
          consumedAt: null,
          lastSentAt: now,
          nextAllowedAt,
        },
      })
      .returning({
        id: verificationSessions.id,
        attemptNumber: verificationSessions.attemptNumber,
      });

    if (!updatedSession)
      throw new CustomError(MSG_OTP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);

    // Replaces any older code: one code row per session
    // (`ux_verification_codes_session`).
    await tx
      .insert(verificationCodes)
      .values({
        sessionId: updatedSession.id,
        code: hashedCode,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: verificationCodes.sessionId,
        set: {
          code: hashedCode,
          expiresAt,
        },
      });

    // Charged HERE and nowhere else, once eligibility is established. Charged
    // earlier in the chain, requests naming addresses nobody owns could exhaust
    // the whole deployment's daily OTP delivery. Inside the transaction so a
    // rejection rolls back the code just stored.
    await enforceOtpGlobalSendBudget({ channel });

    return {
      nextAllowedIn: Math.ceil(
        (nextAllowedAt.getTime() - now.getTime()) / 1000
      ),
      attemptsRemaining: OTP_MAX_ATTEMPTS - updatedSession.attemptNumber,
      sessionId: updatedSession.id,
    };
  });

  // A max-attempts block stored no code, so there is nothing to deliver.
  if (deferredError) throw deferredError;

  // Delivery follows the commit so provider latency cannot hold row locks and a
  // pool connection. A failed delivery removes and refunds only the matching
  // code, so it cannot erase or refund a newer send.
  if (!result)
    throw new CustomError(MSG_OTP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  const deliver = async () => {
    try {
      await deliverOtp(channel, sendTo, otpCode, purpose);
    } catch (error) {
      try {
        await refundFailedDelivery(result.sessionId, hashedCode);
      } catch (refundError) {
        console.error(
          sanitizeForLog({
            msg: 'otp.delivery.refundFailed',
            error: refundError,
          })
        );
      }
      throw error;
    }
  };
  if (deferDelivery) deferDelivery(deliver);
  else await deliver();

  return {
    nextAllowedIn: result.nextAllowedIn,
    attemptsRemaining: result.attemptsRemaining,
  };
}
