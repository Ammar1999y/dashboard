import { beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import { DATABASE_RETRY_AFTER_S, MAX_POOL_CONNECTIONS } from '@/db/limits';
import {
  accounts,
  auditLogs,
  roles,
  sessions,
  twoFactorMethods,
  users,
  verifications,
} from '@/db/schema';
import { ROUTES } from '@/routes';
import * as z from 'zod';

import { REQUIRE_EMAIL_VERIFICATION } from '@app/shared/config';
import { OAUTH_STATE_LOST_PAGE } from '@app/shared/validation/oauth';

import { auth } from '@/lib/auth';
import { hasAdminReauth } from '@/lib/auth/reauth/window';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/session/rotation';
import { totpEnrolmentKey } from '@/lib/auth/verifications';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { openApiDocument } from '@/lib/http/openapi/document';
import { toPublishedManifest } from '@/lib/http/route-manifest';
import { generateUuidV7 } from '@/lib/id';

import { errorClassOf } from '@/utils/log';
import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import { connectionClosedError, driverError } from '../helpers/faults';
import { startGoogle } from '../helpers/google';
import { sentMail, settleDelivery } from '../helpers/mailbox';
import { seedOtpProof } from '../helpers/otp';
import { resetRateLimits } from '../helpers/rate-limit';
import {
  baseHeaders,
  mergeCookies,
  seedUser,
  signIn,
  uniquePhone,
} from '../helpers/session';

beforeEach(resetTables);
beforeEach(resetRateLimits);

async function enrolOtp(userId: string, channels: ('email' | 'sms')[]) {
  await db.insert(twoFactorMethods).values(
    channels.map((channel, index) => ({
      userId,
      method: 'otp' as const,
      channel,
      isDefault: index === 0,
    }))
  );
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, userId));
}

async function userState(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return {
    user,
    accounts: await db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, userId)),
    sessions: await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId)),
  };
}

describe('Google sign-in through the routed OAuth exchange', () => {
  test('enabled capabilities and OpenAPI describe the routed callback without credentials', async () => {
    const response = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/capabilities`, {
        headers: baseHeaders(),
      })
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { oauthProviders: ['google'] },
    });
    const document = openApiDocument(toPublishedManifest(ROUTES, true));
    expect(document).toMatchObject({
      paths: {
        '/api/auth/oauth/google/start': {
          post: { requestBody: { required: true } },
        },
        '/api/auth/oauth/google/callback': {
          get: {
            responses: {
              '302': { headers: { Location: { schema: { type: 'string' } } } },
            },
          },
        },
        '/api/auth/oauth/result': { get: { responses: { '200': {} } } },
        '/api/auth/reauth/methods': {
          get: { security: [{ sessionCookie: [] }] },
        },
      },
    });
    expect(JSON.stringify(document)).not.toContain(
      'harness-google-client-secret'
    );
    expect(JSON.stringify(document)).not.toContain(
      'harness.apps.googleusercontent.com'
    );
  });
  test('Google honors test-only required-email-verification without changing the shipped default', async () => {
    const child = Bun.spawn(
      ['bun', '--no-env-file', 'tests/fixtures/_oauth-required-email-child.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect([await child.exited, error]).toEqual([0, '']);
    expect(output).toContain('Required-email-verification Google flow passed.');
  }, 20_000);

  test('Google first factor completes through the existing local OTP verifier', async () => {
    const phone = uniquePhone();
    const owner = await seedUser({
      emailVerified: false,
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await db.insert(twoFactorMethods).values({
      userId: owner.userId,
      method: 'otp',
      channel: 'sms',
      isDefault: true,
    });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const flow = await startGoogle({
      sub: 'local-otp-subject',
      email: owner.email,
    });
    const response = await flow.callback();
    const cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
    await seedOtpProof({
      userId: owner.userId,
      identifier: phone,
      purpose: 'two_factor',
      channel: 'sms',
      code: '424242',
    });
    const verified = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/two-factor/otp/verify`, {
        method: 'POST',
        headers: baseHeaders({
          cookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ code: '424242', option: 'otp:phone' }),
      })
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ data: { loggedIn: true } });
    const live = await auth.api.getSession({
      headers: new Headers({
        cookie: mergeCookies(cookie, verified.headers.getSetCookie()),
      }),
    });
    expect(live?.user.id).toBe(owner.userId);
    const verifiedCookie = mergeCookies(
      cookie,
      verified.headers.getSetCookie()
    );
    const trusted = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/two-factor/trust-device`, {
        method: 'POST',
        headers: baseHeaders({
          cookie: verifiedCookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: '{}',
      })
    );
    expect(trusted.status).toBe(200);
    const next = await startGoogle(
      { sub: 'local-otp-subject', email: owner.email },
      { cookie: mergeCookies(verifiedCookie, trusted.headers.getSetCookie()) }
    );
    const challenged = await next.callback();
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, owner.userId));
    expect(
      events.some((event) =>
        JSON.stringify(event.newData).includes('"firstFactor":"google"')
      )
    ).toBe(true);
  });

  test('Google refuses an account whose only second factor is the mailbox Google just proved', async () => {
    const owner = await seedUser();
    await enrolOtp(owner.userId, ['email']);
    const flow = await startGoogle({
      sub: 'email-otp-only-subject',
      email: owner.email,
    });
    const response = await flow.callback();
    expect(response.status).toBe(401);
    await settleDelivery();
    expect(sentMail().filter((mail) => mail.to === owner.email)).toEqual([]);
    const after = await userState(owner.userId);
    expect(after.sessions).toHaveLength(0);
  });

  test('that refusal is audited although the sign-in transaction rolls back', async () => {
    const owner = await seedUser();
    await enrolOtp(owner.userId, ['email']);
    const flow = await startGoogle({
      sub: 'email-otp-only-audited-subject',
      email: owner.email,
    });
    const response = await flow.callback();
    expect(response.status).toBe(401);

    const after = await userState(owner.userId);
    expect(
      after.accounts.filter((account) => account.providerId === 'google')
    ).toHaveLength(0);
    expect(after.sessions).toHaveLength(0);
    const refusals = await db
      .select({ newData: auditLogs.newData })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, owner.userId),
          eq(auditLogs.tableName, 'sessions')
        )
      );
    // Written after the rollback, so it describes no session.
    expect(refusals.map((row) => row.newData)).toEqual([
      expect.objectContaining({
        reason: 'two_factor_excluded_by_first_factor',
        twoFactorRefused: true,
        sessionRolledBack: true,
        firstFactor: 'google',
      }),
    ]);
    expect(refusals[0]?.newData).not.toHaveProperty('sessionAbandoned');
  });

  test('Google never offers the email OTP beside another second factor', async () => {
    const owner = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrolOtp(owner.userId, ['email', 'sms']);
    const flow = await startGoogle({
      sub: 'mixed-otp-subject',
      email: owner.email,
    });
    const response = await flow.callback();
    expect(response.status).toBe(200);
    const body = z
      .object({
        twoFactorRedirect: z.literal(true),
        twoFactorOptions: z.array(z.object({ id: z.string() })),
        defaultMethod: z.string().nullable(),
      })
      .parse(await response.json());
    expect(body.twoFactorOptions.map((option) => option.id)).toEqual([
      'otp:phone',
    ]);
    expect(body.defaultMethod).toBe('otp:phone');
    const sent = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/two-factor/otp/send`, {
        method: 'POST',
        headers: baseHeaders({
          cookie: mergeCookies(flow.cookie, response.headers.getSetCookie()),
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ option: 'otp:email' }),
      })
    );
    expect(sent.status).not.toBe(200);
    await settleDelivery();
    expect(sentMail().filter((mail) => mail.to === owner.email)).toEqual([]);
  });

  test('more concurrent Google challenges than the pool holds all complete', async () => {
    const flows = [];
    for (let index = 0; index < MAX_POOL_CONNECTIONS + 2; index++) {
      const owner = await seedUser({
        phoneNumber: uniquePhone(),
        phoneNumberVerified: true,
      });
      await enrolOtp(owner.userId, ['sms']);
      flows.push(
        await startGoogle({
          sub: `pool-subject-${index}`,
          email: owner.email,
        })
      );
    }
    const responses = await Promise.all(flows.map((flow) => flow.callback()));
    expect(responses.map((response) => response.status)).toEqual(
      flows.map(() => 200)
    );
  }, 30_000);

  test('first exact match links and verifies without replacing administrator fields; password still works', async () => {
    expect(REQUIRE_EMAIL_VERIFICATION).toBe(false);
    const owner = await seedUser({ emailVerified: false });
    await signIn(owner);
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: 'first-subject',
      email: ` ${owner.email.toUpperCase()} `,
      name: 'Provider name',
      picture: 'https://example.invalid/image',
    });
    expect(
      flow.url.searchParams.get('scope')?.split(' ').toSorted(compareCodeUnits)
    ).toEqual(['email', 'openid']);
    expect(flow.url.searchParams.get('access_type')).toBe('online');
    expect(flow.url.searchParams.get('nonce')).toBeTruthy();
    const response = await flow.callback();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { loggedIn: true } });
    const after = await userState(owner.userId);
    expect(after.user).toMatchObject({
      name: before.user?.name,
      roleId: owner.roleId,
      email: owner.email,
      emailVerified: true,
    });
    expect(
      after.accounts.filter((account) => account.providerId === 'google')
    ).toHaveLength(1);
    expect(
      after.accounts.find((account) => account.providerId === 'google')
    ).toMatchObject({
      accountId: 'first-subject',
      issuer: 'https://accounts.google.com',
      password: null,
    });
    const cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
    expect(live?.user.id).toBe(owner.userId);
    await signIn(owner);
  });

  test('unknown identities cannot register through the plugin or lower library routes', async () => {
    const flow = await startGoogle({
      sub: 'unknown-subject',
      email: 'unknown@gmail.com',
    });
    const response = await flow.callback();
    expect(response.status).toBe(401);
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
    for (const path of [
      '/sign-in/social',
      '/callback/google',
      '/link-social',
      '/sign-up/email',
    ]) {
      const lower = await auth.handler(
        new Request(`${PUBLIC_ORIGIN}/api/auth${path}`, {
          method: 'POST',
          headers: baseHeaders({
            'content-type': 'application/json',
            origin: PUBLIC_ORIGIN,
          }),
          body: JSON.stringify({
            provider: 'google',
            email: 'unknown@gmail.com',
          }),
        })
      );
      expect(lower.status).toBe(404);
    }
  });

  test.each([
    'outlook.com',
    'hotmail.com',
    'live.com',
    'yahoo.com',
    'workspace.example',
  ])('rejects %s without mutation', async (domain) => {
    const owner = await seedUser({ emailVerified: false });
    if (domain !== 'workspace.example')
      await db
        .update(users)
        .set({ email: `eligible@${domain}` })
        .where(eq(users.id, owner.userId));
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: `subject-${domain}`,
      email: `eligible@${domain}`,
      ...(domain === 'workspace.example' && { hd: domain }),
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test.each(['inactive', 'deleted', 'inactive-role'])(
    'refuses an %s identity before linking or verification',
    async (condition) => {
      const owner = await seedUser({ emailVerified: false });
      if (condition === 'inactive-role')
        await db
          .update(roles)
          .set({ isActive: false })
          .where(eq(roles.id, owner.roleId));
      else
        await db
          .update(users)
          .set(
            condition === 'inactive'
              ? { isActive: false }
              : { deletedAt: new Date(), isActive: false }
          )
          .where(eq(users.id, owner.userId));
      const before = await userState(owner.userId);
      const flow = await startGoogle({
        sub: 'ineligible-subject',
        email: owner.email,
      });
      await expect(flow.callback()).resolves.toHaveProperty('status', 401);
      expect(await userState(owner.userId)).toEqual(before);
    }
  );

  test('returning subject cannot follow a changed email, even to another local user', async () => {
    const first = await seedUser({ emailVerified: false });
    const second = await seedUser({ emailVerified: false });
    const initial = await startGoogle({
      sub: 'stable-subject',
      email: first.email,
    });
    await expect(initial.callback()).resolves.toHaveProperty('status', 200);
    const before = [
      await userState(first.userId),
      await userState(second.userId),
    ] as const;
    for (const email of ['changed@gmail.com', second.email]) {
      const flow = await startGoogle({ sub: 'stable-subject', email });
      await expect(flow.callback()).resolves.toHaveProperty('status', 401);
      expect([
        await userState(first.userId),
        await userState(second.userId),
      ]).toEqual([...before]);
    }
    const collision = await startGoogle({
      sub: 'second-subject',
      email: first.email,
    });
    await expect(collision.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(first.userId)).toEqual(before[0]);
  });

  test('concurrent callback replay produces one link and one verification transition', async () => {
    const owner = await seedUser({ emailVerified: false });
    const flow = await startGoogle({
      sub: 'concurrent-subject',
      email: owner.email,
    });
    // The loser either finds the state already consumed (the lost-state 302) or
    // reads it first and loses the once-marker (401); which is timing.
    const responses = await Promise.all([flow.callback(), flow.callback()]);
    const [won, lost] = responses
      .map((response) => response.status)
      .toSorted((a, b) => a - b);
    expect(won).toBe(200);
    expect([302, 401]).toContain(lost ?? 0);
    const state = await userState(owner.userId);
    expect(
      state.accounts.filter((account) => account.providerId === 'google')
    ).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    await expect(flow.callback()).resolves.toHaveProperty('status', 302);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.recordId, owner.userId));
    expect(
      audits.filter((audit) =>
        JSON.stringify(audit.newData).includes('emailVerified')
      )
    ).toHaveLength(1);
  });

  test('failed session admission rolls back a first link and email verification', async () => {
    const owner = await seedUser({ emailVerified: false });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: 'no-usable-factor',
      email: owner.email,
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test.each([undefined, ['pwd'], 'mfa', ['mfa', 1]])(
    'no exact verified MFA evidence (%j) reaches local 2FA',
    async (amr) => {
      const owner = await seedUser({
        emailVerified: false,
        phoneNumber: uniquePhone(),
        phoneNumberVerified: true,
      });
      await db.insert(twoFactorMethods).values({
        userId: owner.userId,
        method: 'otp',
        channel: 'sms',
        isDefault: true,
      });
      await db
        .update(users)
        .set({ twoFactorEnabled: true })
        .where(eq(users.id, owner.userId));
      const flow = await startGoogle({
        sub: 'two-factor-subject',
        email: owner.email,
        amr,
      });
      const response = await flow.callback();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        twoFactorRedirect: true,
        twoFactorMethods: ['otp'],
      });
      const after = await userState(owner.userId);
      expect(after.sessions).toHaveLength(0);
    }
  );

  test('current signed amr=mfa bypasses local 2FA and is audited', async () => {
    const owner = await seedUser({ emailVerified: false });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const flow = await startGoogle({
      sub: 'mfa-subject',
      email: owner.email,
      amr: ['pwd', 'mfa'],
    });
    const response = await flow.callback();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { loggedIn: true } });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, owner.userId));
    expect(
      audits.some((audit) =>
        JSON.stringify(audit.newData).includes('google_mfa')
      )
    ).toBe(true);
    const next = await startGoogle({ sub: 'mfa-subject', email: owner.email });
    await expect(next.callback()).resolves.toHaveProperty('status', 401);
  });

  test.each([
    { email_verified: false },
    { email_verified: 'true' },
    { nonce: 'wrong' },
    { iss: 'https://attacker.example' },
    { aud: 'another-client' },
    { exp: 1 },
    { exp: undefined },
    { azp: 'other.apps.googleusercontent.com' },
    { sub: '' },
  ])('rejects invalid claims %j', async (override) => {
    const owner = await seedUser({ emailVerified: false });
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: 'invalid-subject',
      email: owner.email,
      ...override,
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test('a forged signature cannot create any durable authentication state', async () => {
    const owner = await seedUser({ emailVerified: false });
    const before = await userState(owner.userId);
    const legitimate = await startGoogle({
      sub: 'forged-subject',
      email: owner.email,
    });
    const parts = legitimate.token.split('.');
    const token = `${parts[0]}.${parts[1]}.${Buffer.alloc(256, 7).toString('base64url')}`;
    const forged = await startGoogle(
      { sub: 'forged-subject', email: owner.email },
      { token }
    );
    await expect(forged.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test.each([false, true])(
    'independent first-link callbacks serialize when subjects differ=%s',
    async (different) => {
      const owner = await seedUser({ emailVerified: false });
      const first = await startGoogle({
        sub: 'race-first',
        email: owner.email,
      });
      const second = await startGoogle({
        sub: different ? 'race-second' : 'race-first',
        email: owner.email,
      });
      const responses = await Promise.all([
        first.callback(),
        second.callback(),
      ]);
      expect(
        responses.map((response) => response.status).toSorted((a, b) => a - b)
      ).toEqual([200, different ? 401 : 200]);
      const after = await userState(owner.userId);
      expect(
        after.accounts.filter((account) => account.providerId === 'google')
      ).toHaveLength(1);
      const audits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.recordId, owner.userId));
      expect(
        audits.filter((audit) =>
          JSON.stringify(audit.newData).includes('emailVerified')
        )
      ).toHaveLength(1);
    }
  );

  // The redirect `parseState` throws drops the cause, so the answer and the
  // one line come from the fault the library caught, by the rule every stage
  // uses: contention is 503 and logged sanitized, anything else 500 by class.
  test.each([
    ['a closed connection', connectionClosedError, 500],
    ['a deadlock', () => driverError('40P01'), 503],
  ] as const)(
    '%s reading the state is not reported as a lost state',
    async (_label, makeFault, status) => {
      const owner = await seedUser();
      const flow = await startGoogle({
        sub: 'state-fault',
        email: owner.email,
      });
      const fault = await makeFault();
      const context = await auth.$context;
      const lookup = spyOn(
        context.internalAdapter,
        'findVerificationValue'
      ).mockRejectedValue(fault);
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await flow.callback();
        expect(lookup).toHaveBeenCalled();
        expect(response.status).toBe(status);
        expect(response.headers.get('retry-after')).toBe(
          status === 503 ? String(DATABASE_RETRY_AFTER_S) : null
        );
        // Not even `parseState`'s own error redirect rides on the answer.
        expect(response.headers.get('location')).toBeNull();
        expect(logged).toHaveBeenCalledTimes(1);
        const line = Bun.inspect(logged.mock.calls[0]);
        expect(line).toContain('oauth.signIn.failed');
        expect(line).toContain('state_unavailable');
        expect(line).toContain(errorClassOf(fault));
        if (status === 503) expect(line).toContain('40P01');
        else
          expect(line).not.toContain(
            fault instanceof Error ? fault.message : String(fault)
          );
      } finally {
        lookup.mockRestore();
        logged.mockRestore();
      }
    }
  );

  test('a state refused after its marker was found is one warning naming the refusal', async () => {
    const owner = await seedUser();
    const flow = await startGoogle({
      sub: 'state-refusal',
      email: owner.email,
    });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Opened in another browser: the marker exists, the state cookie does not.
      const response = await app.handle(
        new Request(
          `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback?state=${flow.url.searchParams.get('state')}&code=harness-code`,
          { headers: baseHeaders() }
        )
      );
      expect(response.headers.get('location')).toBe(
        `${PUBLIC_ORIGIN}${OAUTH_STATE_LOST_PAGE}`
      );
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).toHaveBeenCalledTimes(1);
      const line = Bun.inspect(warnings.mock.calls[0]);
      expect(line).toContain('state_lost');
      expect(line).toContain('state_security_mismatch');
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  test.each([undefined, '/finish'])(
    'a deadlock after a valid state answers 503 with Retry-After, callbackURL %p',
    async (callbackURL) => {
      const owner = await seedUser();
      const flow = await startGoogle(
        { sub: 'deadlock-subject', email: owner.email },
        { callbackURL }
      );
      const context = await auth.$context;
      const deadlock = spyOn(
        context.internalAdapter,
        'consumeVerificationValue'
      ).mockRejectedValue(
        new Error('Failed query', {
          cause: Object.assign(new Error('deadlock detected'), {
            errno: '40P01',
          }),
        })
      );
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await flow.callback();
        expect(deadlock).toHaveBeenCalled();
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe(
          String(DATABASE_RETRY_AFTER_S)
        );
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.getSetCookie()).not.toContainEqual(
          expect.stringContaining('oauth_result')
        );
      } finally {
        deadlock.mockRestore();
        logged.mockRestore();
      }
    }
  );

  test('an unexpected exception after a valid state answers 500, not a credential refusal', async () => {
    const owner = await seedUser();
    const flow = await startGoogle(
      { sub: 'unexpected-subject', email: owner.email },
      { callbackURL: '/finish' }
    );
    const context = await auth.$context;
    const consume = spyOn(
      context.internalAdapter,
      'consumeVerificationValue'
    ).mockRejectedValue(new Error('connection terminated'));
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await flow.callback();
      expect(consume).toHaveBeenCalled();
      expect(response.status).toBe(500);
      expect(response.headers.get('location')).toBeNull();
    } finally {
      consume.mockRestore();
      logged.mockRestore();
    }
  });

  test("a state naming one of the application's verification rows never reaches the lookup", async () => {
    const owner = await seedUser();
    await db.insert(verifications).values({
      identifier: totpEnrolmentKey(owner.userId),
      value: owner.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const answers = await Promise.all(
      [owner.userId, generateUuidV7()].map((userId) =>
        app.handle(
          new Request(
            `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback?state=${totpEnrolmentKey(userId)}&code=harness-code`,
            { headers: baseHeaders() }
          )
        )
      )
    );
    // One answer for the row that exists and the one that does not.
    expect(answers.map((answer) => answer.status)).toEqual([400, 400]);
  });

  test('callback state binds the browser; off-origin return URLs and forged client profiles fail', async () => {
    const owner = await seedUser();
    const flow = await startGoogle({
      sub: 'state-subject',
      email: owner.email,
    });
    const noCookie = await app.handle(
      new Request(
        `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback?state=${flow.url.searchParams.get('state')}&code=harness-code`,
        { headers: baseHeaders() }
      )
    );
    // The lost state held the flow's callbackURL, so the browser goes to the
    // one page that can say "start again" instead of landing on raw JSON.
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.get('location')).toBe(
      `${PUBLIC_ORIGIN}${OAUTH_STATE_LOST_PAGE}`
    );
    for (const body of [
      { callbackURL: 'https://attacker.example' },
      { email: owner.email, sub: 'forged' },
    ]) {
      const response = await app.handle(
        new Request(`${PUBLIC_ORIGIN}/api/auth/oauth/google/start`, {
          method: 'POST',
          headers: baseHeaders({
            'content-type': 'application/json',
            origin: PUBLIC_ORIGIN,
          }),
          body: JSON.stringify(body),
        })
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });

  test('Google sign-in never grants reauthentication, even with a new authentication timestamp', async () => {
    const owner = await seedUser();
    const first = await startGoogle({
      sub: 'reauth-subject',
      email: owner.email,
      auth_time: Math.floor(Date.now() / 1000),
    });
    const response = await first.callback();
    const cookie = mergeCookies(first.cookie, response.headers.getSetCookie());
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(live?.session.id).toBeTruthy();
    const result = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/oauth/google/start`, {
        method: 'POST',
        headers: baseHeaders({
          cookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ mode: 'reauth' }),
      })
    );
    expect(result.status).toBe(400);
    expect(first.url.searchParams.has('max_age')).toBe(false);
    expect(await hasAdminReauth(live?.session.id ?? '', owner.userId)).toBe(
      false
    );
  });

  test('email rotation unlinks and invalidates a pending Google exchange', async () => {
    const owner = await seedUser();
    const initial = await startGoogle({
      sub: 'rotated-subject',
      email: owner.email,
    });
    await expect(initial.callback()).resolves.toHaveProperty('status', 200);
    const pending = await startGoogle({
      sub: 'rotated-subject',
      email: owner.email,
    });
    await withTransaction(async (tx) => {
      await tx
        .select()
        .from(users)
        .where(eq(users.id, owner.userId))
        .for('update');
      await tx
        .update(users)
        .set({ email: `changed.${owner.email}` })
        .where(eq(users.id, owner.userId));
      await unlinkGoogle(
        tx,
        owner.userId,
        { userId: owner.userId, email: `changed.${owner.email}` },
        { ip: null, userAgent: null, apiPath: '/test/email-change' }
      );
      await revokePendingProofs(tx, owner.userId);
      await revokeOtherSessions(tx, owner.userId);
    });
    await expect(pending.callback()).resolves.toHaveProperty('status', 401);
    expect(
      await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, owner.userId),
            eq(accounts.providerId, 'google')
          )
        )
    ).toHaveLength(0);
    const after = await userState(owner.userId);
    expect(after.sessions).toHaveLength(0);
  });
});
