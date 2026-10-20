/**
 * The success of the anonymous contact verification, which no other test
 * reaches: every other case of `POST /api/auth/otp/verify` is a refusal. The
 * right code answers `{ verified: true }` and marks the contact verified, and
 * the runner's response check holds the answer to its published contract.
 */
import { beforeAll, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

import { verifyOtp } from '@app/shared/api/auth';
import { otpMsg } from '@app/shared/messages/otp';

import { resetTables } from '../helpers/database';
import { expectData } from '../helpers/expect-body';
import { seedOtpProof } from '../helpers/otp';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

beforeAll(async () => {
  await resetTables();
  // The verify limiter keys on `TEST_IP`, in fixed windows that outlive a file.
  resetSqliteStores();
});

// One floored request; the rest of the budget is room for seeding in a busy tier.
test('the right code verifies the contact', async () => {
  const user = await seedUser({ emailVerified: false });
  const { code } = await seedOtpProof({
    userId: user.userId,
    identifier: user.email,
    purpose: 'verify_contact',
    code: '135790',
  });

  const response = await app.handle(
    new Request('http://localhost/api/auth/otp/verify', {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ channel: 'email', email: user.email, code }),
    })
  );

  expect(await expectData(response, verifyOtp)).toEqual({
    message: otpMsg.verifySuccess('email'),
    data: { verified: true },
  });
  const [row] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, user.userId));
  expect(row?.emailVerified).toBe(true);
}, 30_000);
