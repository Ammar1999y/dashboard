/**
 * A credential rotation that commits after a first factor was proven, but
 * before what that proof earns is written, voids it: the session, the 2FA
 * challenge and the recovery grant are refused, not written after the sweep
 * that should have taken them. The rotation is run between the OTP commit and
 * the next step, which is where an unlocked write used to land.
 *
 * Every refusal is asserted on the rows as well as the status, beside a twin
 * request without the rotation that succeeds. A rotation started once the
 * write holds the user's row must queue behind it and then sweep what it wrote.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq, inArray, like } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import {
  auditLogs,
  sessions,
  twoFactorMethods,
  users,
  verifications,
} from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';

import {
  revokeOtherSessions,
  revokePendingProofs,
} from '@/lib/auth/session/rotation';
import * as methods from '@/lib/auth/two-factor/methods';
import * as userEligibility from '@/lib/auth/user-eligibility';
import {
  twoFactorAttemptsKey,
  twoFactorChallengeKey,
  twoFactorStateKey,
  twoFactorWebauthnKey,
} from '@/lib/auth/verifications';
import { PUBLIC_ORIGIN } from '@/lib/env';
import * as otpChallenge from '@/lib/otp/challenge';
import * as lockOrder from '@/lib/users/lock-order';
import { lockUser } from '@/lib/users/lock-order';

import { resetTables, waitForUserLock } from '../helpers/database';
import { seedOtpProof } from '../helpers/otp';
import { resetRateLimits } from '../helpers/rate-limit';
import { baseHeaders, seedUser, uniquePhone } from '../helpers/session';
import { recordStatements } from '../helpers/statements';

const CODE = '424242';
const NEW_PASSWORD = 'Harness!Rotated1';

function post(path: string, body: unknown, cookie = '') {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(cookie && { cookie }),
      }),
      body: JSON.stringify(body),
    })
  );
}

/** What a password reset by the owner or an administrator does. */
async function rotate(userId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await lockUser(tx, userId);
    await revokeOtherSessions(tx, userId);
    await revokePendingProofs(tx, userId);
  });
}

/** Runs a rotation right after the next code verification commits. */
function rotateAfterVerify(userId: string) {
  const verify = otpChallenge.verifyRequesterOtp;
  return spyOn(otpChallenge, 'verifyRequesterOtp').mockImplementationOnce(
    async (options) => {
      await verify(options);
      await rotate(userId);
    }
  );
}

/** A second factor on the phone, so a code sent by email leaves one to ask for. */
async function seedPhoneFactorUser(): Promise<SeededUser> {
  const user = await seedUser({
    phoneNumber: uniquePhone(),
    phoneNumberVerified: true,
  });
  await db
    .insert(twoFactorMethods)
    .values({ userId: user.userId, method: 'otp', channel: 'sms' });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, user.userId));
  return user;
}

async function proofCookie(
  user: SeededUser,
  purpose: 'passwordless_login' | 'forgot_password'
): Promise<string> {
  const { cookie } = await seedOtpProof({
    userId: user.userId,
    identifier: user.email,
    purpose,
    code: CODE,
  });
  return cookie;
}

function signInWithCode(user: SeededUser, cookie: string) {
  return post(
    '/api/auth/passwordless/verify',
    { channel: 'email', email: user.email, code: CODE },
    cookie
  );
}

function sessionsOf(userId: string) {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

/** The challenge rows and recovery grants rotation finds by value. */
function pendingRowsOf(userId: string, prefix: '2fa-' | 'recovery-') {
  return db
    .select({ identifier: verifications.identifier })
    .from(verifications)
    .where(
      and(
        eq(verifications.value, userId),
        like(verifications.identifier, `${prefix}%`)
      )
    );
}

beforeAll(async () => {
  await resetTables();
});

afterEach(() => {
  resetRateLimits();
});

describe('a rotation between a passwordless code and its session', () => {
  test('refuses the session', async () => {
    const twin = await seedUser();
    const accepted = await signInWithCode(
      twin,
      await proofCookie(twin, 'passwordless_login')
    );
    expect(accepted.status).toBe(HTTP_STATUS.OK);
    expect(await sessionsOf(twin.userId)).toHaveLength(1);

    const user = await seedUser();
    const cookie = await proofCookie(user, 'passwordless_login');
    const spy = rotateAfterVerify(user.userId);
    try {
      const refused = await signInWithCode(user, cookie);
      expect(refused.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(refused.headers.getSetCookie().join(';')).not.toContain(
        'session_token='
      );
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await sessionsOf(user.userId)).toHaveLength(0);
  });

  test('refuses the second-factor challenge', async () => {
    const twin = await seedPhoneFactorUser();
    const challenged = await signInWithCode(
      twin,
      await proofCookie(twin, 'passwordless_login')
    );
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await pendingRowsOf(twin.userId, '2fa-')).toHaveLength(1);

    const user = await seedPhoneFactorUser();
    const cookie = await proofCookie(user, 'passwordless_login');
    const spy = rotateAfterVerify(user.userId);
    try {
      const refused = await signInWithCode(user, cookie);
      expect(refused.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await pendingRowsOf(user.userId, '2fa-')).toHaveLength(0);
    expect(await sessionsOf(user.userId)).toHaveLength(0);
  });
});

describe('a rotation between a recovery code and its grant', () => {
  const reset = (user: SeededUser, cookie: string) =>
    post(
      '/api/auth/forgot-password/reset',
      {
        channel: 'email',
        email: user.email,
        code: CODE,
        newPassword: NEW_PASSWORD,
      },
      cookie
    );

  test('refuses the grant', async () => {
    const twin = await seedPhoneFactorUser();
    const granted = await reset(
      twin,
      await proofCookie(twin, 'forgot_password')
    );
    expect(await granted.json()).toMatchObject({
      data: { twoFactorRequired: true },
    });
    expect(await pendingRowsOf(twin.userId, 'recovery-')).toHaveLength(1);

    const user = await seedPhoneFactorUser();
    const cookie = await proofCookie(user, 'forgot_password');
    const spy = rotateAfterVerify(user.userId);
    try {
      const refused = await reset(user, cookie);
      expect(refused.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await pendingRowsOf(user.userId, 'recovery-')).toHaveLength(0);
  });
});

describe('a fault deciding the second factor after the first one', () => {
  /** Fails the enrolment read the challenge decision starts with. */
  function failEnrolmentRead() {
    return spyOn(methods, 'readEnrolmentState').mockImplementationOnce(() =>
      Promise.reject(new Error('probe: enrolment read failed'))
    );
  }

  test('on a password sign-in, deletes the session the library committed', async () => {
    const user = await seedPhoneFactorUser();
    const spy = failEnrolmentRead();
    let failed: Response;
    try {
      failed = await post('/api/auth/sign-in/email', {
        email: user.email,
        password: user.password,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(failed.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(await sessionsOf(user.userId)).toHaveLength(0);

    const events = await db
      .select({ action: auditLogs.action, newData: auditLogs.newData })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, user.userId),
          eq(auditLogs.tableName, 'sessions')
        )
      );
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'DELETE',
        newData: expect.objectContaining({
          sessionAbandoned: true,
          reason: 'two_factor_check_failed',
        }),
      })
    );
  });

  test('on a passwordless sign-in, leaves no session and no login record', async () => {
    const user = await seedPhoneFactorUser();
    const cookie = await proofCookie(user, 'passwordless_login');
    const spy = failEnrolmentRead();
    let failed: Response;
    try {
      failed = await signInWithCode(user, cookie);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(failed.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(await sessionsOf(user.userId)).toHaveLength(0);
    expect(
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.userId, user.userId),
            eq(auditLogs.tableName, 'sessions')
          )
        )
    ).toHaveLength(0);
  });
});

describe('rotation with pending sign-in challenges', () => {
  /** Challenges as `issueTwoFactorChallenge` writes them; answers every key. */
  async function seedChallenges(userId: string, count: number) {
    const expiresAt = new Date(Date.now() + 60_000);
    const rows = Array.from({ length: count }, () => {
      const challenge = twoFactorChallengeKey(crypto.randomUUID());
      return [
        { identifier: challenge, value: userId, expiresAt },
        { identifier: twoFactorAttemptsKey(challenge), value: '0', expiresAt },
        { identifier: twoFactorStateKey(challenge), value: '{}', expiresAt },
        { identifier: twoFactorWebauthnKey(challenge), value: '{}', expiresAt },
      ];
    }).flat();
    await db.insert(verifications).values(rows);
    return rows.map((row) => row.identifier);
  }

  async function rotationStatements(count: number): Promise<number> {
    const user = await seedUser();
    const keys = await seedChallenges(user.userId, count);
    const recorder = recordStatements();
    try {
      await rotate(user.userId);
    } finally {
      recorder.stop();
    }
    expect(
      await db
        .select({ id: verifications.id })
        .from(verifications)
        .where(inArray(verifications.identifier, keys))
    ).toHaveLength(0);
    return recorder.statements.length;
  }

  test('spends the same statements for one challenge as for five', async () => {
    expect(await rotationStatements(5)).toBe(await rotationStatements(1));
  });
});

describe('a rotation that arrives while the write holds the user', () => {
  /**
   * After the first lock call that follows the code verification, starts a
   * rotation and holds the request until the rotation is queued on the user's
   * row, or has finished, which it can only do if nothing holds the row.
   */
  function rotateBehind(
    lock: 'lockUser' | 'lockEligibleAuthUser',
    userId: string
  ) {
    const lockUserOriginal = lockOrder.lockUser;
    const lockEligibleOriginal = userEligibility.lockEligibleAuthUser;
    const state: { verified: boolean; rotating: Promise<void> | null } = {
      verified: false,
      rotating: null,
    };
    const verify = otpChallenge.verifyRequesterOtp;
    const verified = spyOn(
      otpChallenge,
      'verifyRequesterOtp'
    ).mockImplementationOnce(async (options) => {
      await verify(options);
      state.verified = true;
    });
    const queueRotation = async () => {
      if (!state.verified || state.rotating) return;
      state.rotating = rotate(userId);
      await Promise.race([state.rotating, waitForUserLock()]);
    };
    const spy =
      lock === 'lockUser'
        ? spyOn(lockOrder, 'lockUser').mockImplementation(async (...args) => {
            await lockUserOriginal(...args);
            await queueRotation();
          })
        : spyOn(userEligibility, 'lockEligibleAuthUser').mockImplementation(
            async (...args) => {
              const locked = await lockEligibleOriginal(...args);
              await queueRotation();
              return locked;
            }
          );
    return {
      restore: () => {
        spy.mockRestore();
        verified.mockRestore();
      },
      finished: async () => {
        expect(state.rotating).not.toBeNull();
        await state.rotating;
      },
    };
  }

  test('a passwordless session is swept once the rotation gets the row', async () => {
    const user = await seedUser();
    const cookie = await proofCookie(user, 'passwordless_login');
    const behind = rotateBehind('lockEligibleAuthUser', user.userId);
    try {
      const accepted = await signInWithCode(user, cookie);
      expect(accepted.status).toBe(HTTP_STATUS.OK);
      await behind.finished();
    } finally {
      behind.restore();
    }
    expect(await sessionsOf(user.userId)).toHaveLength(0);
  });

  test('a recovery grant is swept once the rotation gets the row', async () => {
    const user = await seedPhoneFactorUser();
    const cookie = await proofCookie(user, 'forgot_password');
    const behind = rotateBehind('lockUser', user.userId);
    try {
      const granted = await post(
        '/api/auth/forgot-password/reset',
        {
          channel: 'email',
          email: user.email,
          code: CODE,
          newPassword: NEW_PASSWORD,
        },
        cookie
      );
      expect(await granted.json()).toMatchObject({
        data: { twoFactorRequired: true },
      });
      await behind.finished();
    } finally {
      behind.restore();
    }
    expect(await pendingRowsOf(user.userId, 'recovery-')).toHaveLength(0);
  });
});
