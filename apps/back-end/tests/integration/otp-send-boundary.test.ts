/**
 * The transaction boundary in `processOtpSend`: delivery runs AFTER the commit.
 *
 * `failNextMail()` requests the delivery failure rather than depending on a
 * real SMTP connection failing, so the assertion runs on every machine, with or
 * without SMTP credentials.
 *
 * The contract these tests pin:
 *
 *  - `processOtpSend` throws, so the caller and the client see the failure
 *  - the spent attempt and the cooldown are REFUNDED (`attemptNumber` back to 0,
 *    `nextAllowedAt` back to null), so a user whose message was never delivered
 *    does not lose one of `OTP_MAX_ATTEMPTS`
 *  - the undelivered code row is REMOVED, so nothing that was never sent stays
 *    verifiable
 *
 * `refundFailedDelivery` (`lib/otp/send.ts`) is what does it, and the property that
 * has to keep holding is narrower than "a refund happens": it is keyed on the
 * exact `(sessionId, hashedCode)` pair, so a failure arriving after the user has
 * already requested a NEWER code must refund nothing and delete nothing. Delivery
 * still runs after the commit — it cannot be rolled back, which is why the refund
 * is a compensating write rather than part of the transaction.
 *
 * The database is per-worker and `resetTables` empties it, so the fixture's
 * email needs no per-run stamp, and a failure between inserts leaves nothing
 * behind.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  roles,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';

import { generateUuidV7 } from '@/lib/id';
import { processOtpSend } from '@/lib/otp/send';

import { resetTables } from '../helpers/database';
import { failNextMail, sentMail, settleDelivery } from '../helpers/mailbox';

/** `emailSchema` only accepts a handful of domains; the send path re-validates. */
const EMAIL = 'otp.boundary.probe@gmail.com';

const fixture: { userId: string; threw: unknown } = {
  userId: '',
  threw: null,
};

beforeAll(async () => {
  await resetTables();

  const roleId = generateUuidV7();
  const userId = generateUuidV7();

  await db.insert(roles).values({
    id: roleId,
    // Full id: a UUID v7 prefix is its timestamp, so a truncated one collides
    // between two roles seeded in the same millisecond.
    roleName: `otp-boundary-${roleId.replaceAll('-', '')}`,
    scope: 'standard',
    isActive: true,
  });
  await db.insert(users).values({
    id: userId,
    name: 'OTP boundary fixture',
    email: EMAIL,
    roleId,
    isActive: true,
  });
  fixture.userId = userId;

  // Requested, not depended on. The old probe needed the environment to have no
  // SMTP credentials; this states the condition under test outright.
  failNextMail(
    Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 })
  );

  try {
    await processOtpSend({
      userId,
      identifier: EMAIL,
      channel: 'email',
      purpose: 'verify_contact',
    });
  } catch (error) {
    fixture.threw = error;
  }
});

async function proofRow() {
  const rows = await db
    .select({
      id: verificationSessions.id,
      attemptNumber: verificationSessions.attemptNumber,
      nextAllowedAt: verificationSessions.nextAllowedAt,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, fixture.userId),
        eq(verificationSessions.purpose, 'verify_contact')
      )
    );
  return rows[0] ?? null;
}

describe('a delivery failure after prepare', () => {
  test('surfaces to the caller', () => {
    expect(fixture.threw).not.toBeNull();
  });

  test('the throw came from the delivery boundary, not from an earlier check', async () => {
    // Without this the assertions below would also pass if `processOtpSend` threw
    // BEFORE attempting delivery — a different bug with identical symptoms. The
    // discriminator is the error's identity: `sendOtpEmail` converts a transport
    // failure into a `CustomError(MSG_EMAIL_SEND_FAILED, 500)` specifically so the
    // transport's own message cannot escape, and no earlier check produces that.
    expect(fixture.threw).toBeInstanceOf(CustomError);
    expect((fixture.threw as CustomError).status).toBe(
      HTTP_STATUS.INTERNAL_ERROR
    );
    // And nothing was recorded as delivered, so the stub rejected rather than
    // silently accepting the message.
    await settleDelivery();
    expect(sentMail()).toEqual([]);
  });

  test('refunds the attempt and cooldown', async () => {
    const row = await proofRow();
    expect(row).not.toBeNull();
    expect(row?.attemptNumber).toBe(0);
    expect(row?.nextAllowedAt).toBeNull();
  });

  test('removes the undelivered code', async () => {
    const row = await proofRow();
    expect(row).not.toBeNull();

    const codes = await db
      .select({ code: verificationCodes.code })
      .from(verificationCodes)
      .where(eq(verificationCodes.sessionId, row?.id ?? ''));

    expect(codes).toHaveLength(0);
  });
});
