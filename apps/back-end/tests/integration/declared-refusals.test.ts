/**
 * Refusals a handler raises past the gate, each held to its contract entry.
 * Under the runner a refusal at a status the entry does not publish, a code it
 * does not declare, or an undeclared business 400 answers 500 and fails the
 * test (`lib/http/run.ts`), so every case here fails without its declaration.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import type { SignedInSession } from '../helpers/session';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  twoFactorMethods,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';

import { OTP_AUTO_VERIFY } from '@app/shared/config';
import { OTP_PROOF_THROTTLE_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_PASSWORD_COMPROMISED } from '@app/shared/messages/auth';
import { MSG_NOT_FOUND } from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { MSG_CUSTOM_ROLE_PREFIX_FORBIDDEN } from '@app/shared/messages/permissions';
import { userMsg } from '@app/shared/messages/users';
import { CUSTOM_ROLE_NAME_PREFIX } from '@app/shared/permissions/roles';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';

import { generateUuidV7 } from '@/lib/id';
import { hashOtpCode } from '@/lib/otp/hash';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { expectError } from '../helpers/expect-body';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
  uniqueEmail,
  uniquePhone,
} from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const fx: { admin: SignedInSession | null } = { admin: null };
const admin = () => {
  if (!fx.admin) throw new Error('fixture not seeded');
  return fx.admin;
};

beforeAll(async () => {
  await resetTables();
  fx.admin = await signedInUser();
}, 30_000);

// The OTP and per-user budgets these routes charge outlive a test otherwise.
beforeEach(resetSqliteStores);

const JSON_HEADERS = { 'content-type': 'application/json' };
const send = (
  session: SignedInSession | null,
  method: string,
  path: string,
  body: unknown
) =>
  app.handle(
    session
      ? authedRequest(session, path, {
          method,
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        })
      : new Request(new URL(path, 'http://localhost'), {
          method,
          headers: baseHeaders(JSON_HEADERS),
          body: JSON.stringify(body),
        })
  );

/** A 429 that names the proof throttle and says when to retry. */
async function expectProofThrottle(response: Response): Promise<void> {
  const body = await expectError(response, HTTP_STATUS.TOO_MANY_REQUESTS);
  expect(body.code).toBe(OTP_PROOF_THROTTLE_CODE);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
}

/** Makes the HIBP fake answer "this password appears in a breach". */
function scriptBreached(candidate: string): void {
  const suffix = crypto
    .createHash('sha1')
    .update(candidate, 'utf8')
    .digest('hex')
    .toUpperCase()
    .slice(5);
  scriptEgress(
    'api.pwnedpasswords.com',
    () =>
      new Response(`${suffix}:42\n`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
  );
}

describe('POST /api/auth/forgot-password/complete', () => {
  const CODE = '515151';
  const NEW_PASSWORD = 'Recovered-Pass-1!';
  const OPTION = 'otp:phone';

  /** A recovery grant for an account whose second factor is an SMS code. */
  async function recoveryGrant() {
    scriptEgress('apis.deewan.sa', () => Response.json({ success: true }));
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

    await send(null, 'POST', '/api/auth/forgot-password/send', {
      channel: 'email',
      email: user.email,
    });
    const [proof] = await db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, user.userId),
          eq(verificationSessions.purpose, 'forgot_password')
        )
      );
    if (!proof) throw new Error('the reset code was not issued');
    // The delivered code is not readable here; a known one replaces it.
    const known = {
      code: hashOtpCode(CODE),
      expiresAt: new Date(Date.now() + 600_000),
    };
    await db
      .insert(verificationCodes)
      .values({ sessionId: proof.id, ...known })
      .onConflictDoUpdate({ target: verificationCodes.sessionId, set: known });

    const reset = await send(null, 'POST', '/api/auth/forgot-password/reset', {
      channel: 'email',
      email: user.email,
      code: CODE,
      newPassword: NEW_PASSWORD,
    });
    expect(reset.status).toBe(HTTP_STATUS.OK);
    const { data } = (await reset.json()) as { data: { grant: string } };
    return { userId: user.userId, grant: data.grant };
  }

  const complete = (grant: string, code: string) =>
    send(null, 'POST', '/api/auth/forgot-password/complete', {
      grant,
      option: OPTION,
      code,
      newPassword: NEW_PASSWORD,
    });

  test.if(EMAIL_OTP_AVAILABLE)(
    'a factor no code was sent for is 404',
    async () => {
      const { grant } = await recoveryGrant();
      await expectError(
        await complete(grant, CODE),
        HTTP_STATUS.NOT_FOUND,
        otpMsg.codeNotSent
      );
    },
    30_000
  );

  test.if(EMAIL_OTP_AVAILABLE)(
    'a blocked second-factor proof is the proof throttle',
    async () => {
      const { userId, grant } = await recoveryGrant();
      const sent = await send(
        null,
        'POST',
        '/api/auth/forgot-password/second-factor/send',
        { grant, option: OPTION }
      );
      expect(sent.status).toBe(HTTP_STATUS.OK);
      await db
        .update(verificationSessions)
        .set({
          isBlocked: true,
          blockedUntil: new Date(Date.now() + 3_600_000),
        })
        .where(
          and(
            eq(verificationSessions.userId, userId),
            eq(verificationSessions.purpose, 'two_factor')
          )
        );
      await expectProofThrottle(await complete(grant, CODE));
    },
    30_000
  );
});

describe('a contact change whose send slot is spent is the proof throttle', () => {
  /** A proof row for `purpose` that has used every send it is allowed. */
  const spentSendSlot = (
    userId: string,
    channel: 'email' | 'sms',
    purpose: 'change_email' | 'change_phone',
    target: string
  ) =>
    db.insert(verificationSessions).values({
      userId,
      channel,
      identifier: target,
      targetIdentifier: target,
      purpose,
      attemptNumber: 5,
      nextAllowedAt: new Date(Date.now() - 1000),
    });

  test.if(!OTP_AUTO_VERIFY && EMAIL_OTP_AVAILABLE)(
    'POST /api/dash/users/me/change-email',
    async () => {
      const session = await signedInUser();
      const newEmail = uniqueEmail();
      await spentSendSlot(
        session.user.userId,
        'email',
        'change_email',
        newEmail
      );
      await expectProofThrottle(
        await send(session, 'POST', '/api/dash/users/me/change-email', {
          currentPassword: session.user.password,
          newEmail,
        })
      );
    },
    30_000
  );

  // The integration tier's phone-contact row runs it.
  test.if(!OTP_AUTO_VERIFY && PHONE_OTP_AVAILABLE)(
    'POST /api/dash/users/me/change-phone',
    async () => {
      const session = await signedInUser();
      const newPhoneNumber = uniquePhone();
      await spentSendSlot(
        session.user.userId,
        'sms',
        'change_phone',
        newPhoneNumber
      );
      await expectProofThrottle(
        await send(session, 'POST', '/api/dash/users/me/change-phone', {
          currentPassword: session.user.password,
          newPhoneNumber,
          channel: 'sms',
        })
      );
    },
    30_000
  );
});

describe('POST /api/dash/users', () => {
  const create = (body: Record<string, unknown>) =>
    send(admin(), 'POST', '/api/dash/users', {
      name: 'Created By Harness',
      email: uniqueEmail(),
      password: 'Harness!Created1',
      roleId: admin().user.roleId,
      isActive: true,
      ...body,
    });

  test('a role id that names no assignable role is 404', async () => {
    await expectError(
      await create({ roleId: generateUuidV7() }),
      HTTP_STATUS.NOT_FOUND,
      MSG_NOT_FOUND
    );
  });

  test('a breached password is 400', async () => {
    const password = 'Harness!Breached1';
    scriptBreached(password);
    await expectError(
      await create({ password }),
      HTTP_STATUS.BAD_REQUEST,
      MSG_PASSWORD_COMPROMISED
    );
  });
});

describe('PUT /api/dash/users/:id', () => {
  const update = (
    target: { userId: string; email: string; roleId: string },
    password: string
  ) =>
    send(admin(), 'PUT', `/api/dash/users/${target.userId}`, {
      name: 'Renamed By Harness',
      email: target.email,
      roleId: target.roleId,
      isActive: true,
      password,
    });

  test('a password for an account that signs in without one is 400', async () => {
    const target = await seedUser({ permissions: {} });
    await db.delete(accounts).where(eq(accounts.userId, target.userId));
    await expectError(
      await update(target, 'Harness!Replaced1'),
      HTTP_STATUS.BAD_REQUEST,
      userMsg.ssoCannotModifyPassword
    );
  });

  test('a breached password is 400', async () => {
    const target = await seedUser({ permissions: {} });
    const password = 'Harness!Breached2';
    scriptBreached(password);
    await expectError(
      await update(target, password),
      HTTP_STATUS.BAD_REQUEST,
      MSG_PASSWORD_COMPROMISED
    );
  });
});

describe('a role name in the custom-role namespace is 400', () => {
  const role = {
    roleName: `${CUSTOM_ROLE_NAME_PREFIX}harness`,
    isActive: true,
    permissions: [{ name: 'users', permissions: { view: true } }],
  };
  const refused = MSG_CUSTOM_ROLE_PREFIX_FORBIDDEN(CUSTOM_ROLE_NAME_PREFIX);

  test('POST /api/dash/permissions', async () => {
    await expectError(
      await send(admin(), 'POST', '/api/dash/permissions', role),
      HTTP_STATUS.BAD_REQUEST,
      refused
    );
  });

  test('PUT /api/dash/permissions/:id', async () => {
    const target = await seedUser({ permissions: {} });
    await expectError(
      await send(
        admin(),
        'PUT',
        `/api/dash/permissions/${target.roleId}`,
        role
      ),
      HTTP_STATUS.BAD_REQUEST,
      refused
    );
  });
});
