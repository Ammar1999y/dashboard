/**
 * Serialisation guarantees, driven CONCURRENTLY against the real database.
 *
 * Each was designed into the code — a `FOR UPDATE` lock, an advisory transaction
 * lock, a row lock around the failed-attempt counter — and each had only
 * sequential coverage, which a lock that silently stopped locking would pass.
 * The assertions here are on the rows after the burst, because a status alone
 * cannot tell "serialised" from "raced and got lucky".
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import {
  accounts,
  auditLogs,
  otpChallenges,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import * as argon2 from 'argon2';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';

import { credentialAccountOf } from '@/lib/auth/credential-account';
import {
  LoginRejected,
  MAX_FAILED_ATTEMPTS,
  verifyLoginAttempt,
} from '@/lib/auth/login-guard';
import { hashPassword } from '@/lib/auth/password/hash';
import { verifyRequesterOtp } from '@/lib/otp/challenge';
import { processOtpSend } from '@/lib/otp/send';

import { resetTables } from '../helpers/database';
import { sentMail, settleDelivery } from '../helpers/mailbox';
import { otpRequester, seedOtpProof } from '../helpers/otp';
import { seedUser } from '../helpers/session';
import { recordStatements } from '../helpers/statements';

/** Satisfies `passwordSchema`, so every attempt reaches the comparison. */
const WRONG_PASSWORD = 'Harness!Wr0ngPass';

function fulfilled<T>(outcomes: PromiseSettledResult<T>[]): T[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : []
  );
}

function rejected<T>(outcomes: PromiseSettledResult<T>[]): unknown[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
}

async function proofRows(userId: string) {
  const sessions = await db
    .select({
      id: verificationSessions.id,
      attemptNumber: verificationSessions.attemptNumber,
      verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      consumedAt: verificationSessions.consumedAt,
    })
    .from(verificationSessions)
    .where(eq(verificationSessions.userId, userId));
  const codes =
    sessions.length > 0
      ? await db
          .select({ id: verificationCodes.id })
          .from(verificationCodes)
          .where(eq(verificationCodes.sessionId, sessions[0]?.id ?? ''))
      : [];
  return { sessions, codes };
}

beforeAll(async () => {
  await resetTables();
});

describe('one correct code presented by six requests at once', () => {
  test('is consumed exactly once, and the losers are neither accepted nor charged', async () => {
    const user = await seedUser();
    const code = '135790';
    const { requester } = otpRequester();
    await seedOtpProof({
      userId: user.userId,
      identifier: user.email,
      purpose: 'passwordless_login',
      code,
      requester,
    });

    const verify = () =>
      verifyRequesterOtp({
        userId: user.userId,
        channel: 'email',
        purpose: 'passwordless_login',
        identifier: user.email,
        code,
        requester,
      });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => verify())
    );

    expect(fulfilled(outcomes)).toHaveLength(1);

    // The user is held FOR UPDATE, so every loser runs after the winner deleted
    // the code and sees "nothing to verify against" — the expired-code answer,
    // which charges no guess. Anything else here means two requests compared
    // the same code.
    const losers = rejected(outcomes);
    expect(losers).toHaveLength(5);
    for (const loser of losers) {
      expect(loser).toBeInstanceOf(CustomError);
      expect((loser as CustomError).status).toBe(HTTP_STATUS.BAD_REQUEST);
    }

    const { sessions } = await proofRows(user.userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.consumedAt).not.toBeNull();
    expect(
      await db
        .select({ id: otpChallenges.id })
        .from(otpChallenges)
        .where(eq(otpChallenges.sessionId, sessions[0]?.id ?? ''))
    ).toHaveLength(0);
  });
});

describe('two first sends for one identifier at once', () => {
  /** A first send for `user`'s address. */
  const firstSend = (user: { userId: string; email: string }) =>
    processOtpSend({
      userId: user.userId,
      identifier: user.email,
      channel: 'email',
      purpose: 'verify_contact',
    });

  test("serialise on the user's row lock: one row, one code, one message, one throttle", async () => {
    // A FIRST send: no row exists yet, so `FOR UPDATE` has nothing to lock and
    // only the user row lock stands between two concurrent INSERTs — without it
    // the second one dies on the unique index as a 500.
    const user = await seedUser({ emailVerified: false });
    const send = () => firstSend(user);

    const outcomes = await Promise.allSettled([send(), send()]);

    expect(fulfilled(outcomes)).toHaveLength(1);
    const [throttled] = rejected(outcomes);
    expect(throttled).toBeInstanceOf(CustomError);
    // The loser ran second and met the winner's cooldown, which is the only
    // rejection a serialised second send can produce.
    expect((throttled as CustomError).status).toBe(
      HTTP_STATUS.TOO_MANY_REQUESTS
    );

    const { sessions, codes } = await proofRows(user.userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.attemptNumber).toBe(1);
    expect(codes).toHaveLength(1);

    await settleDelivery();
    expect(sentMail()).toHaveLength(1);
  });

  test('take that lock and no other before reading the proof row', async () => {
    const user = await seedUser({ emailVerified: false });
    const recorder = recordStatements();
    await firstSend(user).finally(recorder.stop);
    await settleDelivery();

    const sent = recorder.statements.map(({ sql }) => sql);
    const proofRead = sent.findIndex((text) =>
      text.includes('from "verification_sessions"')
    );
    expect(sent.slice(0, proofRead)).toEqual([
      expect.stringMatching(/from "users" .* for no key update$/),
    ]);
  });
});

describe('parallel wrong passwords', () => {
  test('are each counted exactly once, with no lost update', async () => {
    const user = await seedUser();
    const attempts = 3;
    expect(attempts).toBeLessThan(MAX_FAILED_ATTEMPTS);

    const outcomes = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        verifyLoginAttempt({
          email: user.email,
          password: WRONG_PASSWORD,
          skipTimingGuard: true,
        })
      )
    );

    expect(fulfilled(outcomes)).toHaveLength(0);
    for (const reason of rejected(outcomes))
      expect(reason).toBeInstanceOf(LoginRejected);

    // The counter is read, compared and incremented under the user row's
    // `FOR UPDATE`; a read-then-write without it would lose increments and
    // report fewer failures than were made.
    const [row] = await db
      .select({
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row).toEqual({ failedLoginAttempts: attempts, lockedUntil: null });
  }, 30_000);
});

describe('the failed-attempt counter while Argon2 runs', () => {
  const AUDIT_META = {
    ip: null,
    userAgent: null,
    apiPath: 'test/login-guard',
  };
  const realVerify = argon2.verify;

  async function lockRow(userId: string) {
    const [row] = await db
      .select({
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, userId));
    return row;
  }

  async function auditedWith(userId: string, flag: string) {
    const rows = await db
      .select({ oldData: auditLogs.oldData, newData: auditLogs.newData })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.userId, userId), eq(auditLogs.tableName, 'users'))
      )
      .orderBy(auditLogs.createdAt, auditLogs.id);
    return rows.filter(
      (row) => (row.newData as Record<string, unknown> | null)?.[flag] === true
    );
  }

  async function auditFlags(userId: string, flag: string): Promise<number> {
    const rows = await auditedWith(userId, flag);
    return rows.length;
  }

  function signIn(email: string, password: string) {
    return verifyLoginAttempt({
      email,
      password,
      skipTimingGuard: true,
      auditMeta: AUDIT_META,
      purpose: 'sign_in',
    });
  }

  test('compares no more guesses than the threshold, however many arrive at once', async () => {
    const user = await seedUser();
    const verify = spyOn(argon2, 'verify');
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: MAX_FAILED_ATTEMPTS * 3 }, () =>
          signIn(user.email, WRONG_PASSWORD)
        )
      );
      expect(fulfilled(outcomes)).toHaveLength(0);
      for (const reason of rejected(outcomes))
        expect(reason).toBeInstanceOf(LoginRejected);
      // Each attempt is charged before it is compared, so the charges past the
      // threshold find the lock and never reach the credential. (On the public
      // route the timing guard still hashes for them.)
      expect(verify).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);
    } finally {
      verify.mockRestore();
    }

    const row = await lockRow(user.userId);
    expect(row?.failedLoginAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(row?.lockedUntil).not.toBeNull();
    expect(await auditFlags(user.userId, 'accountLocked')).toBe(1);
  }, 30_000);

  test.each([
    ['a correct', true],
    ['a wrong', false],
  ] as const)(
    '%s password is hashed with the user row unlocked',
    async (_label, correct) => {
      const user = await seedUser();
      const lockable: boolean[] = [];
      const verify = spyOn(argon2, 'verify').mockImplementation(
        async (...args) => {
          // NOWAIT: a held row lock fails this at once instead of queueing.
          lockable.push(
            await withTransaction(async (tx) => {
              await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, user.userId))
                .for('update', { noWait: true });
              return true;
            }).catch(() => false)
          );
          return realVerify(...args);
        }
      );
      try {
        const attempt = signIn(
          user.email,
          correct ? user.password : WRONG_PASSWORD
        );
        if (correct) await attempt;
        else await expect(attempt).rejects.toBeInstanceOf(LoginRejected);
      } finally {
        verify.mockRestore();
      }
      expect(lockable).toEqual([true]);
      expect(await lockRow(user.userId)).toEqual({
        failedLoginAttempts: correct ? 0 : 1,
        lockedUntil: null,
      });
    },
    30_000
  );

  test('a charge at the threshold refuses a concurrent attempt uncompared until a correct password settles it', async () => {
    const user = await seedUser();
    await db
      .update(users)
      .set({ failedLoginAttempts: MAX_FAILED_ATTEMPTS - 1 })
      .where(eq(users.id, user.userId));

    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const verify = spyOn(argon2, 'verify').mockImplementation(
      async (...args) => {
        entered.resolve();
        await gate.promise;
        return realVerify(...args);
      }
    );
    try {
      const first = signIn(user.email, user.password);
      await entered.promise;

      // Under a lock held across the hash this would queue behind `first`.
      const second = await Promise.race([
        signIn(user.email, user.password)
          .then(() => 'accepted')
          .catch((error: unknown) => error),
        Bun.sleep(3000).then(() => 'still waiting'),
      ]);
      expect(second).toBeInstanceOf(LoginRejected);
      expect(verify).toHaveBeenCalledTimes(1);

      gate.resolve();
      expect(await first).toHaveLength(1);
    } finally {
      gate.resolve();
      verify.mockRestore();
    }

    expect(await lockRow(user.userId)).toEqual({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    // The lock was real for the length of a hash: audited with the charge,
    // and its clearing with the verification.
    expect(await auditFlags(user.userId, 'accountLocked')).toBe(1);
    const [verified] = await auditedWith(user.userId, 'passwordVerified');
    expect(verified?.oldData).toMatchObject({
      failedLoginAttempts: MAX_FAILED_ATTEMPTS,
      lockedUntil: expect.any(String),
    });
    expect(verified?.newData).toMatchObject({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }, 30_000);

  test('two overlapping verifications each audit the row they settled', async () => {
    const user = await seedUser();
    await db
      .update(users)
      .set({ failedLoginAttempts: MAX_FAILED_ATTEMPTS - 2 })
      .where(eq(users.id, user.userId));

    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ] as const;
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ] as const;
    let calls = 0;
    const verify = spyOn(argon2, 'verify').mockImplementation(
      async (...args) => {
        const index = calls++ as 0 | 1;
        entered[index].resolve();
        await gates[index].promise;
        return realVerify(...args);
      }
    );
    try {
      // The first takes the second-to-last slot; the second sets the lock.
      const first = signIn(user.email, user.password);
      await entered[0].promise;
      const second = signIn(user.email, user.password);
      await entered[1].promise;

      gates[0].resolve();
      expect(await first).toHaveLength(1);
      gates[1].resolve();
      expect(await second).toHaveLength(1);
    } finally {
      for (const gate of gates) gate.resolve();
      verify.mockRestore();
    }

    expect(await lockRow(user.userId)).toEqual({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    const verified = await auditedWith(user.userId, 'passwordVerified');
    expect(verified.map((row) => row.oldData)).toEqual([
      {
        failedLoginAttempts: MAX_FAILED_ATTEMPTS,
        lockedUntil: expect.any(String),
      },
      { failedLoginAttempts: 0, lockedUntil: null },
    ]);
  }, 30_000);

  test.each([
    ['a first', 0],
    ['the threshold', MAX_FAILED_ATTEMPTS - 1],
  ] as const)(
    'a password written while Argon2 runs voids the verification and keeps %s charge',
    async (_label, failedBefore) => {
      const user = await seedUser();
      await db
        .update(users)
        .set({ failedLoginAttempts: failedBefore })
        .where(eq(users.id, user.userId));
      const replacement = await hashPassword('Harness!Replaced1');
      const verify = spyOn(argon2, 'verify').mockImplementation(
        async (...args) => {
          // A credential write, taking the user lock first as every writer does.
          await withTransaction(async (tx) => {
            await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, user.userId))
              .for('update', { noWait: true });
            await tx
              .update(accounts)
              .set({ password: replacement })
              .where(credentialAccountOf(user.userId));
          });
          return realVerify(...args);
        }
      );
      try {
        await expect(signIn(user.email, user.password)).rejects.toBeInstanceOf(
          LoginRejected
        );
      } finally {
        verify.mockRestore();
      }

      const locked = failedBefore + 1 >= MAX_FAILED_ATTEMPTS;
      const row = await lockRow(user.userId);
      expect(row?.failedLoginAttempts).toBe(failedBefore + 1);
      expect(row?.lockedUntil === null).toBe(!locked);
      // A lock left standing is never an unaudited one.
      expect(await auditFlags(user.userId, 'accountLocked')).toBe(
        locked ? 1 : 0
      );
      expect(await auditFlags(user.userId, 'passwordVerified')).toBe(0);
      const [account] = await db
        .select({ password: accounts.password })
        .from(accounts)
        .where(credentialAccountOf(user.userId));
      expect(account?.password).toBe(replacement);
    },
    30_000
  );
});
