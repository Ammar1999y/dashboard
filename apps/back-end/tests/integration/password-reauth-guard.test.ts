/**
 * The password check behind every authenticated re-authentication: what a
 * locked account is told, how the admin window's proof is labelled, what an
 * unevaluatable stored hash answers, and the contact change that would strand
 * the only second factor.
 */
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import crypto from 'node:crypto';
import type { SeededUser, SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  auditLogs,
  twoFactorMethods,
  users,
  verificationSessions,
} from '@/db/schema';

import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  twoFactorMsg,
} from '@app/shared/messages/auth';
import { userMsg } from '@app/shared/messages/users';

import {
  LOCK_DURATION_SECONDS,
  MAX_FAILED_ATTEMPTS,
} from '@/lib/auth/login-guard';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import { sentMail, settleDelivery } from '../helpers/mailbox';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signIn,
} from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

/** Every case pays at least one sign-in and one verify at 64 MiB Argon2id. */
setDefaultTimeout(30_000);

beforeAll(async () => {
  await resetTables();
});

beforeEach(() => {
  resetSqliteStores();
});

/** `origin` because the Better Auth paths validate it on any cookie-bearing request. */
function post(
  session: SignedInSession,
  path: string,
  body: unknown
): Promise<Response> {
  return app.handle(
    authedRequest(session, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
      body: JSON.stringify(body),
    })
  );
}

function signInRaw(email: string, password: string): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email, password }),
    })
  );
}

async function lockAccount(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      failedLoginAttempts: MAX_FAILED_ATTEMPTS,
      lockedUntil: new Date(Date.now() + LOCK_DURATION_SECONDS * 1000),
    })
    .where(eq(users.id, userId));
}

async function lockState(userId: string) {
  const [row] = await db
    .select({
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

async function storedHash(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return row?.password ?? null;
}

async function proofPurposes(userId: string): Promise<unknown[]> {
  const rows = await db
    .select({ newData: auditLogs.newData })
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId));
  return rows
    .map((row) => (row.newData as { purpose?: unknown } | null)?.purpose)
    .filter((purpose) => purpose !== undefined);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}@gmail.com`;
}

interface ReauthSurface {
  path: string;
  body: (user: SeededUser) => Record<string, unknown>;
  /** The app's `{ success, message, data }`, or Better Auth's error body. */
  envelope: boolean;
}

describe('a locked account, re-authenticating with its correct password', () => {
  const surfaces: ReauthSurface[] = [
    {
      path: '/api/dash/auth/reauth',
      body: (user: SeededUser) => ({ password: user.password }),
      envelope: true,
    },
    {
      path: '/api/dash/users/me/change-password',
      body: (user: SeededUser) => ({
        currentPassword: user.password,
        newPassword: 'Harness!Rotated1',
      }),
      envelope: true,
    },
    {
      path: '/api/dash/users/me/change-email',
      body: (user: SeededUser) => ({
        currentPassword: user.password,
        newEmail: uniqueEmail('locked'),
      }),
      envelope: true,
    },
    // `requireReauthPassword`, the app-owned 2FA endpoints.
    {
      path: '/api/auth/two-factor/totp/start',
      body: (user: SeededUser) => ({ password: user.password }),
      envelope: false,
    },
    // `path-policy.ts`, the Better Auth paths that reach `password.verify`.
    {
      path: '/api/auth/two-factor/get-totp-uri',
      body: (user: SeededUser) => ({ password: user.password }),
      envelope: false,
    },
  ];

  test.each(surfaces)(
    '$path is told the account is locked, not that the password is wrong',
    async ({ path, body, envelope }) => {
      const user = await seedUser();
      const session = await signIn(user);
      await lockAccount(user.userId);
      const before = await lockState(user.userId);
      const hashBefore = await storedHash(user.userId);

      const response = await post(session, path, body(user));

      expect(response.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(LOCK_DURATION_SECONDS);
      expect(await response.json()).toEqual(
        envelope
          ? {
              success: false,
              message: userMsg.accountTemporarilyLocked,
              data: null,
            }
          : {
              message: userMsg.accountTemporarilyLocked,
              code: CUSTOM_AUTH_CODE,
            }
      );

      // A lock is not a failed attempt, and nothing was written.
      expect(await lockState(user.userId)).toEqual(before);
      expect(await storedHash(user.userId)).toBe(hashBefore);
      await settleDelivery();
      expect(sentMail()).toEqual([]);
    }
  );

  test('the anonymous sign-in still cannot tell a lock from an unknown account', async () => {
    const user = await seedUser();
    await lockAccount(user.userId);

    const locked = await signInRaw(user.email, user.password);
    const unknown = await signInRaw(uniqueEmail('nobody'), user.password);

    expect(locked.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(unknown.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    const lockedBody = await locked.json();
    expect(lockedBody).toEqual(await unknown.json());
    expect(lockedBody).toMatchObject({ message: MSG_INVALID_CREDENTIALS });
    expect(locked.headers.get('retry-after')).toBeNull();
  });
});

test('the admin re-auth window is audited as its own purpose', async () => {
  const user = await seedUser();
  const session = await signIn(user);

  const response = await post(session, '/api/dash/auth/reauth', {
    password: user.password,
  });

  expect(response.status).toBe(HTTP_STATUS.OK);
  expect(await proofPurposes(user.userId)).toEqual(['sign_in', 'reauth_admin']);
});

describe('a stored hash whose PHC string argon2 cannot parse', () => {
  test.each([
    [
      'a garbage body',
      (pepperId: string) => `p1:${pepperId}:$argon2id$${'g'.repeat(60)}`,
    ],
    [
      'a non-numeric memory cost',
      (pepperId: string, phc: string) =>
        `p1:${pepperId}:${phc.replace(/m=\d+/, 'm=abc')}`,
    ],
  ] as const)(
    '%s answers the wrong-password 401 and charges an attempt',
    async (_label, corrupt) => {
      const user = await seedUser();
      const stored = await storedHash(user.userId);
      const [, pepperId = '', ...phcParts] = stored?.split(':') ?? [];
      await db
        .update(accounts)
        .set({ password: corrupt(pepperId, phcParts.join(':')) })
        .where(eq(accounts.userId, user.userId));

      const corrupted = await signInRaw(user.email, user.password);
      const unknown = await signInRaw(uniqueEmail('nobody'), user.password);

      expect(corrupted.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(await corrupted.json()).toEqual(await unknown.json());
      // The throw used to roll the increment back, so lockout never engaged.
      const after = await lockState(user.userId);
      expect(after?.failedLoginAttempts).toBe(1);
    }
  );
});

test('a change-email that would strand the only second factor is refused before any code is sent', async () => {
  const user = await seedUser();
  // Before the factor exists, or sign-in would stop at the challenge.
  const session = await signIn(user);
  await db.insert(twoFactorMethods).values({
    userId: user.userId,
    method: 'otp',
    channel: 'email',
    isDefault: true,
  });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, user.userId));

  const response = await post(session, '/api/dash/users/me/change-email', {
    currentPassword: user.password,
    newEmail: uniqueEmail('stranding'),
  });

  expect(response.status).toBe(HTTP_STATUS.CONFLICT);
  expect(await response.json()).toEqual({
    success: false,
    message: twoFactorMsg.contactChangeStrands,
    data: null,
  });
  await settleDelivery();
  expect(sentMail()).toEqual([]);
  expect(
    await db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(eq(verificationSessions.userId, user.userId))
  ).toEqual([]);
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, user.userId));
  expect(row?.email).toBe(user.email);
});

test('the phone variant is refused before any SMS is sent', async () => {
  const child = Bun.spawn(
    ['bun', '--no-env-file', 'tests/fixtures/_contact-change-strand-child.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email,sms' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status, error).toBe(0);
  expect(output).toContain(
    'change-phone refused the stranding change before any SMS.'
  );
});
