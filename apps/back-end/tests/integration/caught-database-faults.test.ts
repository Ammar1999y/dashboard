/**
 * A database fault caught on an auth path is a fault, never a refusal: where
 * its outcome decides the answer it reaches the boundary (503 with
 * `Retry-After` for contention, 500 otherwise), logged once and charging no
 * attempt; where the work is best-effort it is logged once and the request
 * carries on.
 *
 * Writes fail through a trigger and reads through a real driver error, so the
 * code meets what PostgreSQL and Bun raise rather than a hand-built shape.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq, like } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import {
  passkeys,
  sessions,
  twoFactorCredentials,
  twoFactorMethods,
  users,
  verifications,
} from '@/db/schema';
import { symmetricEncrypt } from 'better-auth/crypto';
import * as z from 'zod';

import { auth } from '@/lib/auth';
import { hasAdminReauth } from '@/lib/auth/reauth/window';
import { issueRecoveryGrant } from '@/lib/auth/recovery/grant';
import * as live from '@/lib/auth/session/live';
import { TWO_FACTOR_ALLOWED_ATTEMPTS } from '@/lib/auth/two-factor/challenge';
import {
  readEnrolmentState,
  recoveryOptions,
} from '@/lib/auth/two-factor/methods';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import {
  connectionClosedError,
  driverError,
  failVerificationWrites,
  failWholeRowReads,
} from '../helpers/faults';
import { seedOtpProof } from '../helpers/otp';
import { resetRateLimits } from '../helpers/rate-limit';
import { baseHeaders, seedUser, signIn, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';
import { syntheticAuthenticator } from '../helpers/webauthn';

const RIGHT_CODE = '646464';
const RP_ID = new URL(PUBLIC_ORIGIN).hostname;

/** Undone after each case, so a failed assertion cannot leave a fault armed. */
const cleanups: (() => unknown)[] = [];

beforeEach(async () => {
  await resetTables();
  await resetSqliteStores();
  await resetRateLimits();
  scriptEgress('challenges.cloudflare.com', () =>
    Response.json({ success: true })
  );
  scriptEgress('apis.deewan.sa', () => Response.json({ success: true }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function call(path: string, cookie: string, body?: object) {
  return app.handle(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: baseHeaders({
        origin: PUBLIC_ORIGIN,
        cookie,
        'content-type': 'application/json',
      }),
      ...(body && { body: JSON.stringify(body) }),
    })
  );
}

/** `console.error`, silenced and counted until the case ends. */
function errorLines() {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  cleanups.push(() => spy.mockRestore());
  return () => spy.mock.calls.map((args) => Bun.inspect(args));
}

async function armWriteFault(
  operation: 'insert' | 'delete',
  pattern: string,
  sqlstate: string
) {
  cleanups.push(await failVerificationWrites(operation, pattern, sqlstate));
}

async function attemptsLeft(pattern: string): Promise<string[]> {
  const rows = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(like(verifications.identifier, pattern));
  return rows.map((row) => row.value);
}

async function enable(
  user: SeededUser,
  method: 'otp' | 'passkey',
  channel: 'sms' | null = null
) {
  await db.insert(twoFactorMethods).values({
    userId: user.userId,
    method,
    channel,
  });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, user.userId));
}

async function otpChallenge() {
  const phone = uniquePhone();
  const user = await seedUser({
    phoneNumber: phone,
    phoneNumberVerified: true,
  });
  await enable(user, 'otp', 'sms');
  const { cookie } = await signIn(user);
  await seedOtpProof({
    userId: user.userId,
    identifier: phone,
    purpose: 'two_factor',
    channel: 'sms',
    code: RIGHT_CODE,
  });
  const verify = () =>
    call('/api/auth/two-factor/otp/verify', cookie, {
      option: 'otp:phone',
      code: RIGHT_CODE,
    });
  return { user, cookie, verify };
}

async function givePasskey(user: SeededUser) {
  const device = syntheticAuthenticator();
  await db.insert(passkeys).values({
    userId: user.userId,
    credentialID: device.credentialID,
    publicKey: device.publicKey,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });
  return device;
}

const challengeSchema = z.object({ data: z.object({ challenge: z.string() }) });

describe('the two-factor sign-in challenge', () => {
  test('a contended attempt spend answers 503 and keeps the budget', async () => {
    const { verify } = await otpChallenge();
    const lines = errorLines();
    await armWriteFault('delete', '2fa-attempts-%', '40P01');

    const refused = await verify();
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe(
      String(DATABASE_RETRY_AFTER_S)
    );
    expect(lines()).toHaveLength(1);
    expect(await attemptsLeft('2fa-attempts-%')).toEqual(['0']);

    await cleanups.pop()?.();
    await expect(verify()).resolves.toHaveProperty('status', 200);
  });

  test('a passkey rejected by WebAuthn charges one attempt; a fault reading the credential charges none', async () => {
    const user = await seedUser();
    const device = await givePasskey(user);
    await enable(user, 'passkey');
    const { cookie } = await signIn(user);
    const assert = async (origin = PUBLIC_ORIGIN) => {
      const started = await call(
        '/api/auth/two-factor/passkey/options',
        cookie,
        {}
      );
      const { data } = challengeSchema.parse(await started.json());
      return device.assertion({
        challenge: data.challenge,
        origin,
        rpId: RP_ID,
      });
    };
    const verify = (response: unknown) =>
      call('/api/auth/two-factor/passkey/verify', cookie, { response });
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warnings.mockRestore());

    const rejected = await verify(await assert('https://attacker.example'));
    expect(rejected.status).toBe(401);
    expect(await attemptsLeft('2fa-attempts-%')).toEqual(['1']);
    // The verifier's reason, once: a wrong origin is a deployment fault too.
    expect(warnings).toHaveBeenCalledTimes(1);
    const warning = Bun.inspect(warnings.mock.calls[0]);
    expect(warning).toContain('passkey.assertion.rejected');
    expect(warning).toContain('https://attacker.example');

    const lines = errorLines();
    for (const [fault, status] of [
      [await driverError('40P01'), 503],
      [await connectionClosedError(), 500],
    ] as const) {
      const assertion = await assert();
      const read = failWholeRowReads(passkeys, fault);
      try {
        const answered = await verify(assertion);
        expect(answered.status).toBe(status);
        expect(answered.headers.get('retry-after')).toBe(
          status === 503 ? String(DATABASE_RETRY_AFTER_S) : null
        );
      } finally {
        read.mockRestore();
      }
    }
    expect(lines()).toHaveLength(2);
    expect(await attemptsLeft('2fa-attempts-%')).toEqual(['1']);

    const accepted = await assert();
    await expect(verify(accepted)).resolves.toHaveProperty('status', 200);
  });

  test('a fault recording the device-trust proof is logged once and the sign-in still completes', async () => {
    const { user, verify } = await otpChallenge();
    const lines = errorLines();
    await armWriteFault('insert', '2fa-proven-%', 'XX000');

    await expect(verify()).resolves.toHaveProperty('status', 200);
    const logged = lines();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('twoFactor.proof.recordFailed');
    expect(logged[0]).toContain('XX000');
    const [session] = await db.query.sessions.findMany({
      where: (row, { eq: is }) => is(row.userId, user.userId),
    });
    if (!session) throw new Error('the sign-in created no session');
    // Drizzle's message carries the bound values; none may reach the line.
    expect(logged[0]).not.toContain(session.id);
    expect(logged[0]).not.toContain('2fa-proven-');
  });
});

describe('best-effort cleanup', () => {
  test('a fault dropping an exhausted challenge is logged once and still refuses', async () => {
    const { verify } = await otpChallenge();
    await db
      .update(verifications)
      .set({ value: String(TWO_FACTOR_ALLOWED_ATTEMPTS) })
      .where(like(verifications.identifier, '2fa-attempts-%'));
    const [state] = await db
      .select({ identifier: verifications.identifier })
      .from(verifications)
      .where(like(verifications.identifier, '2fa-state-%'));
    if (!state) throw new Error('the challenge has no state row');
    const lines = errorLines();
    await armWriteFault('delete', '2fa-state-%', 'XX000');

    const refused = await verify();
    expect(refused.status).toBe(400);
    const logged = lines();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('twoFactor.challenge.cleanupFailed');
    expect(logged[0]).toContain('XX000');
    // The identifier carries the challenge id, a bound value.
    expect(logged[0]).not.toContain(state.identifier);
  });

  test('a fault invalidating an exhausted recovery grant is logged once and still refuses', async () => {
    const phone = uniquePhone();
    const user = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await enable(user, 'otp', 'sms');
    const grant = await issueRecoveryGrant({
      userId: user.userId,
      excludeContactKind: 'email',
      options: recoveryOptions(await readEnrolmentState(user.userId), 'email'),
    });
    await db
      .update(verifications)
      .set({ value: '5' })
      .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
    const lines = errorLines();
    await armWriteFault('delete', 'recovery-state-%', 'XX000');

    const refused = await call('/api/auth/forgot-password/complete', '', {
      grant,
      option: 'otp:phone',
      code: RIGHT_CODE,
      newPassword: 'Recovered-Pass-1!',
    });
    expect(refused.status).toBe(400);
    const logged = lines();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('recovery.grant.invalidateFailed');
    expect(logged[0]).toContain('XX000');
    expect(logged[0]).not.toContain(grant);
    // The spent counter alone is what refuses the grant from here on.
    expect(await attemptsLeft(`recovery-attempts-${grant}`)).toEqual([]);
  }, 30_000);
});

describe('the plugin’s delegated verifiers', () => {
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const BACKUP_CODES = ['aaaaa-bbbbb', 'ccccc-ddddd'];
  const KEY = process.env.BETTER_AUTH_SECRET ?? '';

  /** TOTP and an acknowledged backup-code set, written directly. */
  async function delegatedChallenge() {
    const user = await seedUser();
    const setId = crypto.randomUUID();
    await db.insert(twoFactorCredentials).values({
      userId: user.userId,
      secret: await symmetricEncrypt({ key: KEY, data: TOTP_SECRET }),
      backupCodes: await symmetricEncrypt({
        key: KEY,
        data: JSON.stringify(BACKUP_CODES),
      }),
      verified: true,
      backupCodesSetId: setId,
      backupCodesAcknowledgedSetId: setId,
      backupCodesAcknowledgedAt: new Date(),
      backupCodesRemaining: BACKUP_CODES.length,
    });
    await db.insert(twoFactorMethods).values([
      { userId: user.userId, method: 'totp' },
      { userId: user.userId, method: 'backup_code' },
    ]);
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, user.userId));
    return signIn(user);
  }

  // The plugin's `beginAttempt` answers a failed counter consume with 401.
  test.each([
    ['verify-totp', '40P01', 503],
    ['verify-totp', 'XX000', 500],
    ['verify-backup-code', '40P01', 503],
    ['verify-backup-code', 'XX000', 500],
  ] as const)(
    '/two-factor/%s answers a fault consuming the counter (%s) with %d',
    async (endpoint, sqlstate, status) => {
      const { cookie } = await delegatedChallenge();
      const { code } =
        endpoint === 'verify-totp'
          ? await auth.api.generateTOTP({ body: { secret: TOTP_SECRET } })
          : { code: BACKUP_CODES[0] };
      const lines = errorLines();
      await armWriteFault('delete', '2fa-attempts-%', sqlstate);

      const answered = await call(`/api/auth/two-factor/${endpoint}`, cookie, {
        code,
      });
      expect(answered.status).toBe(status);
      expect(answered.headers.get('retry-after')).toBe(
        status === 503 ? String(DATABASE_RETRY_AFTER_S) : null
      );
      expect(lines()).toHaveLength(1);
      expect(await attemptsLeft('2fa-attempts-%')).toEqual(['0']);
    }
  );

  test('a fault reading the challenge state after the sign-in is logged once and the sign-in stands', async () => {
    const signedIn = await delegatedChallenge();
    const context = await auth.$context;
    const find = context.internalAdapter.findVerificationValue;
    const fault = await driverError('XX000');
    const sessionCount = async () => {
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, signedIn.user.userId));
      return rows.length;
    };
    const before = await sessionCount();
    // Only the read after the session exists: the earlier ones gate the verify.
    const read = spyOn(
      context.internalAdapter,
      'findVerificationValue'
    ).mockImplementation(async (...args) => {
      if (args[0].startsWith('2fa-state-') && (await sessionCount()) > before)
        throw fault;
      return find(...args);
    });
    cleanups.push(() => read.mockRestore());
    const lines = errorLines();

    const verified = await call(
      '/api/auth/two-factor/verify-backup-code',
      signedIn.cookie,
      { code: BACKUP_CODES[0] }
    );
    expect(verified.status).toBe(200);
    const logged = lines();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('twoFactor.completion.stateReadFailed');
    expect(logged[0]).toContain('completion audit');
  });

  // And drops a failed re-arm.
  test('a fault recording a wrong code answers 500 naming it, and charges nothing', async () => {
    const { cookie } = await delegatedChallenge();
    const lines = errorLines();
    await armWriteFault('insert', '2fa-attempts-%', 'XX000');
    const verify = (code: string) =>
      call('/api/auth/two-factor/verify-backup-code', cookie, { code });

    const answered = await verify('zzzzz-zzzzz');
    expect(answered.status).toBe(500);
    // The fault itself, not the aborted transaction's next statement (25P02).
    const logged = lines();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('XX000');
    expect(await attemptsLeft('2fa-attempts-%')).toEqual(['0']);

    await cleanups.pop()?.();
    await expect(verify(BACKUP_CODES[0] ?? '')).resolves.toHaveProperty(
      'status',
      200
    );
  });
});

describe('re-authentication', () => {
  async function passkeySession() {
    const user = await seedUser();
    const device = await givePasskey(user);
    const signedIn = await signIn(user);
    const current = await auth.api.getSession({
      headers: new Headers({ cookie: signedIn.cookie }),
    });
    if (!current) throw new Error('Missing test session.');
    return {
      user,
      device,
      cookie: signedIn.cookie,
      sessionId: current.session.id,
    };
  }

  test('a fault reading the credential answers 5xx, not invalid credentials, and the ceremony survives it', async () => {
    const { user, device, cookie, sessionId } = await passkeySession();
    const started = await call('/api/auth/reauth/passkey/options', cookie, {});
    const { data } = challengeSchema.parse(await started.json());
    const assertion = device.assertion({
      challenge: data.challenge,
      origin: PUBLIC_ORIGIN,
      rpId: RP_ID,
    });
    const verify = () =>
      call('/api/auth/reauth/passkey/verify', cookie, { response: assertion });

    const lines = errorLines();
    for (const [fault, status] of [
      [await driverError('40P01'), 503],
      [await connectionClosedError(), 500],
    ] as const) {
      const read = failWholeRowReads(passkeys, fault);
      try {
        const answered = await verify();
        expect(answered.status).toBe(status);
        expect(answered.headers.get('retry-after')).toBe(
          status === 503 ? String(DATABASE_RETRY_AFTER_S) : null
        );
      } finally {
        read.mockRestore();
      }
    }
    expect(lines()).toHaveLength(2);
    expect(await hasAdminReauth(sessionId, user.userId)).toBe(false);

    await expect(verify()).resolves.toHaveProperty('status', 200);
    expect(await hasAdminReauth(sessionId, user.userId)).toBe(true);
  });

  test('a fault minting or spending the enrolment grant answers 5xx, not invalid credentials', async () => {
    const user = await seedUser();
    const { cookie } = await signIn(user);
    const lines = errorLines();
    const context = await auth.$context;

    const mint = spyOn(
      context.internalAdapter,
      'createVerificationValue'
    ).mockRejectedValueOnce(await driverError('40P01'));
    try {
      const minted = await call('/api/auth/two-factor/passkey/grant', cookie, {
        password: user.password,
      });
      expect(minted.status).toBe(503);
    } finally {
      mint.mockRestore();
    }

    const granted = await call('/api/auth/two-factor/passkey/grant', cookie, {
      password: user.password,
    });
    const { data } = z
      .object({ data: z.object({ grant: z.string() }) })
      .parse(await granted.json());
    await armWriteFault('delete', 'reauth-two_factor_enrolment-%', '40P01');
    const spent = await call('/api/auth/passkey/delete-passkey', cookie, {
      id: generateUuidV7(),
      grant: data.grant,
    });
    expect(spent.status).toBe(503);
    expect(spent.headers.get('retry-after')).toBe(
      String(DATABASE_RETRY_AFTER_S)
    );
    expect(lines()).toHaveLength(2);
    expect(
      await attemptsLeft(`reauth-two_factor_enrolment-${data.grant}`)
    ).toHaveLength(1);
  });

  test('a fault checking the session is live answers 500, not sign in again', async () => {
    const user = await seedUser();
    const { cookie } = await signIn(user);
    const lines = errorLines();
    const check = spyOn(live, 'assertLiveSession').mockRejectedValueOnce(
      await connectionClosedError()
    );
    cleanups.push(() => check.mockRestore());

    const answered = await call('/api/auth/reauth/methods', cookie);
    expect(check).toHaveBeenCalled();
    expect(answered.status).toBe(500);
    expect(lines()).toHaveLength(1);
    await expect(
      call('/api/auth/reauth/methods', cookie)
    ).resolves.toHaveProperty('status', 200);
  });
});

describe('account recovery', () => {
  test('a contended attempt spend at completion answers 503 and keeps the budget', async () => {
    const phone = uniquePhone();
    const user = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await enable(user, 'otp', 'sms');
    const grant = await issueRecoveryGrant({
      userId: user.userId,
      excludeContactKind: 'email',
      options: recoveryOptions(await readEnrolmentState(user.userId), 'email'),
    });
    const lines = errorLines();
    await armWriteFault('delete', 'recovery-attempts-%', '40P01');

    const refused = await call('/api/auth/forgot-password/complete', '', {
      grant,
      option: 'otp:phone',
      code: RIGHT_CODE,
      newPassword: 'Recovered-Pass-1!',
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe(
      String(DATABASE_RETRY_AFTER_S)
    );
    expect(lines()).toHaveLength(1);
    expect(await attemptsLeft(`recovery-attempts-${grant}`)).toEqual(['0']);
    const [still] = await db
      .select({ id: verifications.id })
      .from(verifications)
      .where(and(eq(verifications.identifier, `recovery-${grant}`)));
    expect(still).toBeDefined();
  }, 30_000);
});
