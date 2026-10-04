import crypto from 'node:crypto';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel, OtpPurpose } from '@app/shared/validation/enums';

import { and, eq, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { verificationCodes, verificationSessions } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { otpMsg } from '@app/shared/messages/otp';
import {
  OTP_CODE_LENGTH,
  OTP_EXPIRY_MINUTES,
} from '@app/shared/validation/constants';
import { contactKindOf } from '@app/shared/validation/enums';

import { lockUser } from '@/lib/auth/user-eligibility';
import { enforceOtpGlobalSendBudget } from '@/lib/rate-limit';

import { logSanitized } from '@/utils/log';

import { deliverOtp } from './delivery';
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
  return crypto
    .randomInt(10 ** (OTP_CODE_LENGTH - 1), 10 ** OTP_CODE_LENGTH)
    .toString();
}

function calculateOtpExpiry(): Date {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
}

interface ProcessOtpSendOptions {
  userId: EntityID;
  /** Normalised; verify must present the same value. */
  identifier: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  /** Contact-change purposes only: the NEW contact, which verify commits. */
  targetIdentifier?: string | null;
  sendTo: string;
  /** Localised label for error messages. */
  entityName: string;
  /**
   * ⚠️ Anonymous send endpoints must pass it: a provider call on the response
   * path outruns any timing floor and makes the send an existence oracle.
   */
  deferDelivery?: (task: () => Promise<void>) => void;
}

interface ProcessOtpSendResult {
  nextAllowedIn: number;
  attemptsRemaining: number;
}

async function refundFailedDelivery(
  userId: EntityID,
  sessionId: EntityID,
  hashedCode: string
): Promise<void> {
  await withTransaction(async (tx) => {
    // Not optional: unlocked, the code row is held here while the session row
    // is awaited, which queues a verify behind a refund that waits on a send.
    await lockUser(tx, userId);
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
  const contactKind = contactKindOf(channel);

  const otpCode = generateOtpCode();
  const hashedCode = hashOtpCode(otpCode);

  // Thrown after the commit, so the max-attempts block persists.
  let deferredError: CustomError | null = null;

  const result = await withTransaction(async (tx) => {
    // ⚠️ First, as `processOtpVerify` takes it: every writer of the user's proof
    // rows queues on this one lock, so none holds a proof row while waiting for
    // another.
    await lockUser(tx, userId);

    // FOR UPDATE locks nothing before the row exists, so two first sends would
    // both INSERT. Keyed like the unique index, on contact kind.
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

    // Before the clear below, so the max-attempts branch keeps the old deadline.
    const existingBlockedUntil = session?.isBlocked
      ? session.blockedUntil
      : null;

    // Cleared, not thrown on — see `VERIFY_BLOCK_CLEARED_BY_RESEND`.
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
        otpMsg.resendWait(waitSeconds),
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    // Before the increment, which `chk_attempt_number_max` would refuse raw.
    // The throw is deferred so the block commits.
    if (session && session.attemptNumber >= OTP_MAX_ATTEMPTS) {
      // Stamped once, or anyone knowing the identifier could roll the penalty.
      // Not guarded on `isBlocked`: the clear above reset it.
      const blockedUntil =
        existingBlockedUntil && existingBlockedUntil > now
          ? existingBlockedUntil
          : calculateBlockDuration();
      await blockSession(tx, session.id, blockedUntil);

      deferredError = blockedError(
        otpMsg.sendBlocked(entityName, OTP_BLOCK_DURATION_HOURS),
        blockedUntil
      );
      return null;
    }

    const expiresAt = calculateOtpExpiry();

    const currentAttempts = session?.attemptNumber ?? 0;
    const nextAllowedAt = calculateNextAllowedAt(currentAttempts + 1, purpose);

    // `verifyAttemptDaily` is left alone, so a fresh code cannot reset it.
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
      throw new CustomError(otpMsg.sendError, HTTP_STATUS.INTERNAL_ERROR);

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

    // Only here: earlier, sends to unowned addresses could exhaust the global
    // budget. In the transaction, so a rejection rolls back the stored code.
    await enforceOtpGlobalSendBudget({ channel });

    return {
      nextAllowedIn: Math.ceil(
        (nextAllowedAt.getTime() - now.getTime()) / 1000
      ),
      attemptsRemaining: OTP_MAX_ATTEMPTS - updatedSession.attemptNumber,
      sessionId: updatedSession.id,
    };
  });

  if (deferredError) throw deferredError;

  // After the commit, so provider latency holds no locks. The refund matches
  // this code only, never a newer send.
  if (!result)
    throw new CustomError(otpMsg.sendError, HTTP_STATUS.INTERNAL_ERROR);
  const deliver = async () => {
    try {
      await deliverOtp(channel, sendTo, otpCode, purpose);
    } catch (error) {
      try {
        await refundFailedDelivery(userId, result.sessionId, hashedCode);
      } catch (refundError) {
        logSanitized('error', {
          msg: 'otp.delivery.refundFailed',
          error: refundError,
        });
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
