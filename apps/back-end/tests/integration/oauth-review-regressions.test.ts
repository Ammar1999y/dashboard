import { beforeEach, expect, spyOn, test } from 'bun:test';
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  auditLogs,
  passkeys,
  sessions,
  twoFactorMethods,
  users,
  verifications,
} from '@/db/schema';
import { verifyGoogleIdToken } from 'better-auth/social-providers';
import * as z from 'zod';

import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_REQUIRED,
} from '@app/shared/messages/auth';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';

import { auth } from '@/lib/auth';
import * as passkeyAssertion from '@/lib/auth/passkey-assertion';
import * as adminReauth from '@/lib/auth/reauth/window';
import * as eligibility from '@/lib/auth/user-eligibility';
import { oauthOnceKey } from '@/lib/auth/verifications';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { startGoogle } from '../helpers/google';
import { dropMockedClockWindows, resetRateLimits } from '../helpers/rate-limit';
import {
  baseHeaders,
  mergeCookies,
  seedUser,
  signIn,
  uniquePhone,
} from '../helpers/session';
import { syntheticAuthenticator } from '../helpers/webauthn';

beforeEach(resetTables);
beforeEach(resetRateLimits);

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

test('Google and password both admit a stale enrollment when the global 2FA feature is disabled', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      'tests/fixtures/_oauth-disabled-two-factor-child.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_ENABLED_2FA_METHODS: '',
        NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
        NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email,sms',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  // Per LINE: a boot writes whatever warnings its configuration earns, and
  // parsing the whole stream asserted that this child emits exactly one.
  const logged = error
    .split(String.fromCodePoint(10))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  expect(logged).toContainEqual(
    expect.objectContaining({
      msg: 'twoFactor.disabled no method configured',
    })
  );
  expect(output).toContain(
    'Google and password honor disabled two-factor configuration.'
  );
}, 20_000);

test('redirect and direct identity denials share the same 401 envelope', async () => {
  const claims = { sub: 'unknown-subject', email: 'unknown@gmail.com' };
  const directFlow = await startGoogle(claims);
  const direct = await directFlow.callback();
  expect(direct.status).toBe(401);
  const flow = await startGoogle(claims, { callbackURL: '/finish' });
  const redirected = await flow.callback();
  expect(redirected.status).toBe(302);
  expect(redirected.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/finish`);
  const cookie = mergeCookies(flow.cookie, redirected.headers.getSetCookie());
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await call('/api/auth/oauth/result', cookie);
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual(await direct.json());
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
  await expect(call('/api/auth/oauth/result', cookie)).resolves.toHaveProperty(
    'status',
    401
  );
});

test('a redirected Google sign-in reads its session back once at /oauth/result', async () => {
  const owner = await seedUser();
  const flow = await startGoogle(
    { sub: 'redirected-success-subject', email: owner.email },
    { callbackURL: '/finish' }
  );
  const redirected = await flow.callback();
  expect(redirected.status).toBe(302);
  expect(redirected.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/finish`);
  const cookie = mergeCookies(flow.cookie, redirected.headers.getSetCookie());
  const result = await call('/api/auth/oauth/result', cookie);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    success: true,
    data: { loggedIn: true },
  });
  const live = await auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(live?.user.id).toBe(owner.userId);
  await expect(call('/api/auth/oauth/result', cookie)).resolves.toHaveProperty(
    'status',
    401
  );
});

test('the one-shot state marker expires with the library state cookie', async () => {
  const started = await call('/api/auth/oauth/google/start', '', {
    mode: 'sign_in',
  });
  expect(started.status).toBe(200);
  const stateCookie = started.headers
    .getSetCookie()
    .find((cookie) => /^[^=]*\.state=/.test(cookie));
  const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(stateCookie ?? '')?.[1]);
  expect(maxAge).toBeGreaterThan(0);
  const body = z
    .object({ data: z.object({ url: z.string() }) })
    .parse(await started.json());
  const state = new URL(body.data.url).searchParams.get('state') ?? '';
  const [marker] = await db
    .select({ expiresAt: verifications.expiresAt })
    .from(verifications)
    .where(eq(verifications.identifier, oauthOnceKey(state)));
  const remaining = (marker?.expiresAt.getTime() ?? 0) - Date.now();
  // The wall clock is not monotonic (a Windows time sync steps it by milliseconds).
  expect(remaining).toBeLessThanOrEqual(maxAge * 1000 + 1000);
  expect(remaining).toBeGreaterThan((maxAge - 10) * 1000);
});

test('an unknown Google identity logs a controlled warning without identity claims', async () => {
  const claims = { sub: 'unknown-log-subject', email: 'unknown-log@gmail.com' };
  const flow = await startGoogle(claims);
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await flow.callback();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: MSG_INVALID_CREDENTIALS,
    });
    expect(warning.mock.calls).toEqual([
      [
        {
          msg: 'oauth.signIn.failed',
          provider: 'google',
          stage: 'identity',
          reason: 'user_ineligible',
        },
      ],
    ]);
    expect(error).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
    error.mockRestore();
  }
});

test('a result-storage failure withdraws the session before answering a server failure', async () => {
  const owner = await seedUser();
  const flow = await startGoogle(
    { sub: 'result-storage-subject', email: owner.email },
    { callbackURL: '/finish' }
  );
  const context = await auth.$context;
  const create = context.internalAdapter.createVerificationValue;
  let failed = false;
  const unavailable = spyOn(
    context.internalAdapter,
    'createVerificationValue'
  ).mockImplementation(async (...args) => {
    if (!failed && args[0].identifier.startsWith('oauth-result-')) {
      failed = true;
      throw new Error('Result storage failed.');
    }
    return create(...args);
  });
  try {
    const response = await flow.callback();
    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId))
    ).toHaveLength(0);
    const result = await call(
      '/api/auth/oauth/result',
      mergeCookies(flow.cookie, response.headers.getSetCookie())
    );
    expect(result.status).toBe(401);
  } finally {
    unavailable.mockRestore();
  }
});

test('post-commit identity admission failure has its own abandonment audit reason', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'admission-subject',
    email: owner.email,
  });
  const context = await auth.$context;
  const find = context.internalAdapter.findUserById;
  const changed = spyOn(
    context.internalAdapter,
    'findUserById'
  ).mockImplementation(async (...args) => {
    const user = await find(...args);
    return user ? { ...user, email: 'changed@gmail.com' } : null;
  });
  try {
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, owner.userId),
          eq(auditLogs.action, 'DELETE'),
          eq(auditLogs.tableName, 'sessions')
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.newData).toMatchObject({
      sessionAbandoned: true,
      reason: 'post_commit_admission_failed',
    });
  } finally {
    changed.mockRestore();
  }
});

test('removing a link between identity lookup and user locking reaches the link-removed guard', async () => {
  const owner = await seedUser();
  const claims = { sub: 'removed-link-subject', email: owner.email };
  const initialFlow = await startGoogle(claims);
  await expect(initialFlow.callback()).resolves.toHaveProperty('status', 200);
  const flow = await startGoogle(claims);
  const lock = eligibility.lockEligibleAuthUser;
  const removed = spyOn(eligibility, 'lockEligibleAuthUser').mockImplementation(
    async (...args) => {
      await db
        .delete(accounts)
        .where(
          and(
            eq(accounts.userId, owner.userId),
            eq(accounts.providerId, 'google')
          )
        );
      return lock(...args);
    }
  );
  const log = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(JSON.stringify(log.mock.calls)).toContain('link_removed');
  } finally {
    removed.mockRestore();
    log.mockRestore();
  }
});

test('unexpected token exchange failures are observable without leaking the provider error', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'transport-subject',
    email: owner.email,
  });
  const secret = 'secret-provider-payload-must-not-be-logged';
  scriptEgress('oauth2.googleapis.com', () => {
    throw new Error(secret);
  });
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await flow.callback();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      message: MSG_INTERNAL_ERROR,
    });
    expect(JSON.stringify(log.mock.calls)).toContain('oauth.signIn.failed');
    expect(JSON.stringify(log.mock.calls)).toContain('token_exchange');
    expect(JSON.stringify(log.mock.calls)).toContain('unexpected_failure');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
});

test('a token endpoint invalid_grant is a refusal in both the direct and the redirected flow', async () => {
  const claims = { sub: 'invalid-grant-subject', email: 'grant@gmail.com' };
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const directFlow = await startGoogle(claims);
    const direct = await directFlow.callback({ code: 'replayed-code' });
    expect(direct.status).toBe(401);
    expect(await direct.clone().json()).toMatchObject({
      message: MSG_INVALID_CREDENTIALS,
    });
    const flow = await startGoogle(claims, { callbackURL: '/finish' });
    const redirected = await flow.callback({ code: 'replayed-code' });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBe(`${PUBLIC_ORIGIN}/finish`);
    const result = await call(
      '/api/auth/oauth/result',
      mergeCookies(flow.cookie, redirected.headers.getSetCookie())
    );
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual(await direct.json());
    const refusal = {
      msg: 'oauth.signIn.failed',
      provider: 'google',
      stage: 'token_exchange',
      reason: 'token_exchange_refused',
    };
    expect(warning.mock.calls).toEqual([[refusal], [refusal]]);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
});

/**
 * Both delivery modes of one scripted token endpoint answer: a server failure
 * is a 500 with an error-level log, never a redirect and never a stored result.
 */
async function expectTokenAnswerIsServerFailure(
  answer: () => Response,
  providerError?: string
) {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const callbackURL of [undefined, '/finish']) {
      log.mockClear();
      const flow = await startGoogle(
        { sub: 'token-fault-subject', email: 'fault@gmail.com' },
        { callbackURL }
      );
      scriptEgress('oauth2.googleapis.com', answer);
      const response = await flow.callback();
      expect(response.status).toBe(500);
      expect(response.headers.get('location')).toBeNull();
      expect(
        response.headers.getSetCookie().some((c) => c.includes('oauth_result'))
      ).toBe(false);
      expect(await response.json()).toMatchObject({
        message: MSG_INTERNAL_ERROR,
      });
      expect(log.mock.calls).toEqual([
        [
          {
            msg: 'oauth.signIn.failed',
            provider: 'google',
            stage: 'token_exchange',
            reason: 'unexpected_failure',
            errorClass: 'Unknown',
            providerError,
          },
        ],
      ]);
      const stored = await db
        .select({ identifier: verifications.identifier })
        .from(verifications);
      expect(
        stored.filter(({ identifier }) => identifier.startsWith('oauth-result'))
      ).toEqual([]);
    }
    expect(warning).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
}

test.each([
  ['invalid_client', 401],
  ['unauthorized_client', 400],
] as const)(
  'a token endpoint %s answer is a server failure in both the direct and the redirected flow',
  (code, status) =>
    expectTokenAnswerIsServerFailure(
      () => Response.json({ error: code }, { status }),
      code
    )
);

test.each([
  [
    '400 without an error code',
    () => Response.json({ error_description: 'bad' }, { status: 400 }),
    undefined,
  ],
  [
    '400 with a non-string error code',
    () => Response.json({ error: 400 }, { status: 400 }),
    undefined,
  ],
  [
    '400 with an array error code',
    () => Response.json({ error: ['invalid_grant'] }, { status: 400 }),
    undefined,
  ],
  [
    '400 with an unregistered error code',
    () => Response.json({ error: 'access_denied' }, { status: 400 }),
    undefined,
  ],
  [
    '400 with a differently cased invalid_grant',
    () => Response.json({ error: 'INVALID_GRANT' }, { status: 400 }),
    undefined,
  ],
  [
    '400 with a non-JSON body naming invalid_grant',
    () => new Response('invalid_grant', { status: 400 }),
    undefined,
  ],
  [
    '400 with an invalid_request code',
    () => Response.json({ error: 'invalid_request' }, { status: 400 }),
    'invalid_request',
  ],
  [
    '400 with an unsupported_grant_type code',
    () => Response.json({ error: 'unsupported_grant_type' }, { status: 400 }),
    'unsupported_grant_type',
  ],
  [
    '400 with an invalid_scope code',
    () => Response.json({ error: 'invalid_scope' }, { status: 400 }),
    'invalid_scope',
  ],
  [
    '503 carrying invalid_grant',
    () => Response.json({ error: 'invalid_grant' }, { status: 503 }),
    'invalid_grant',
  ],
] as const)(
  'a token endpoint %s is a server failure, not a refusal',
  (_label, answer, providerError) =>
    expectTokenAnswerIsServerFailure(answer, providerError)
);

test('a token endpoint 5xx answer stays a server failure', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'token-5xx-subject',
    email: owner.email,
  });
  scriptEgress('oauth2.googleapis.com', () =>
    Response.json({ error: 'backend_error' }, { status: 503 })
  );
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await flow.callback();
    expect(response.status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).toContain('unexpected_failure');
    expect(warning).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
});

test.each([
  [
    '/api/dash/users/me/change-password',
    { newPassword: 'Review!ChangedPassw0rd' },
  ],
  ['/api/dash/users/me/change-email', { newEmail: 'review-target@gmail.com' }],
  ['/api/auth/two-factor/disable', {}],
  ['/api/auth/two-factor/methods/disable', { method: 'passkey' }],
  ['/api/auth/two-factor/generate-backup-codes', {}],
  ['/api/auth/two-factor/passkey/grant', {}],
  ['/api/auth/two-factor/get-totp-uri', {}],
] as const)(
  'missing credential proof has one reauthentication code at %s',
  async (path, body) => {
    const owner = await seedUser();
    const { cookie } = await signIn(owner);
    const response = await call(path, cookie, body);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: MSG_REAUTH_REQUIRED,
      code: REAUTH_REQUIRED_CODE,
    });
  }
);

test('authorization URL explicitly requests signed MFA evidence and a nonce with minimal scopes', async () => {
  const flow = await startGoogle({
    sub: 'url-subject',
    email: 'url@gmail.com',
  });
  const params = flow.url.searchParams;
  expect(params.get('scope')?.split(' ').toSorted(compareCodeUnits)).toEqual([
    'email',
    'openid',
  ]);
  expect(params.get('nonce')).toMatch(/^[\w-]{43}$/);
  expect(params.get('state')).toBeTruthy();
  expect(params.get('code_challenge')).toBeTruthy();
  expect(params.get('code_challenge_method')).toBe('S256');
  expect(params.get('include_granted_scopes')).toBeNull();
  expect(params.get('access_type')).toBe('online');
  expect(JSON.parse(params.get('claims') ?? '{}')).toEqual({
    id_token: { amr: { essential: true } },
  });
});

test('administrative reauthentication-required errors retain their machine code through response serialization', async () => {
  const administrator = await seedUser({ roleScope: 'system' });
  const target = await seedUser();
  const { cookie } = await signIn(administrator);
  const response = await app.handle(
    new Request(`${PUBLIC_ORIGIN}/api/dash/users/${target.userId}`, {
      method: 'DELETE',
      headers: baseHeaders({ cookie, origin: PUBLIC_ORIGIN }),
    })
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    message: MSG_REAUTH_REQUIRED,
    code: REAUTH_REQUIRED_CODE,
  });
});

test('the installed Google verifier accepts a token without exp, so the callback must require it', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'missing-exp-subject',
    email: owner.email,
    exp: undefined,
  });
  const claims = await verifyGoogleIdToken({
    token: flow.token,
    audience: 'harness.apps.googleusercontent.com',
    nonce: flow.url.searchParams.get('nonce') ?? '',
  });
  expect(claims).toBeTruthy();
  expect(claims?.exp).toBeUndefined();
  await expect(flow.callback()).resolves.toHaveProperty('status', 401);
});

test.each([
  { code: null, error: 'access_denied' },
  { iss: 'https://untrusted.example' },
])(
  'callback rejects provider cancellation or issuer mismatch: %j',
  async (query) => {
    const owner = await seedUser();
    const flow = await startGoogle({
      sub: 'callback-subject',
      email: owner.email,
    });
    await expect(flow.callback(query)).resolves.toHaveProperty('status', 401);
    expect(
      await db.select().from(accounts).where(eq(accounts.providerId, 'google'))
    ).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  }
);

test('a browser session belonging to someone else cannot change which Google identity is admitted', async () => {
  const other = await seedUser();
  const owner = await seedUser();
  const { cookie } = await signIn(other);
  const flow = await startGoogle(
    { sub: 'different-browser-subject', email: owner.email },
    { cookie }
  );
  const response = await flow.callback();
  expect(response.status).toBe(200);
  const live = await auth.api.getSession({
    headers: new Headers({
      cookie: mergeCookies(flow.cookie, response.headers.getSetCookie()),
    }),
  });
  expect(live?.user.id).toBe(owner.userId);
  const linked = await db
    .select()
    .from(accounts)
    .where(eq(accounts.providerId, 'google'));
  expect(linked.map((entry) => entry.userId)).toEqual([owner.userId]);
});

test.each([false, true])(
  'signed Workspace hd syntax does not impose an extra email-domain equality policy (matching=%s)',
  async (matching) => {
    const owner = await seedUser();
    owner.email = `hosted-${matching}@outlook.com`;
    await db
      .update(users)
      .set({ email: owner.email })
      .where(eq(users.id, owner.userId));
    const flow = await startGoogle({
      sub: `hosted-${matching}`,
      email: owner.email,
      hd: matching ? 'outlook.com' : 'workspace.example',
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 200);
  }
);

test.each([
  { amr: ['mfa', 'pwd', 'swk'], bypass: true },
  { amr: ['hwk'], bypass: false },
  { amr: ['swk'], bypass: false },
])('only exact signed mfa bypasses local 2FA: %j', async ({ amr, bypass }) => {
  const owner = await seedUser();
  const device = syntheticAuthenticator();
  await db.insert(passkeys).values({
    userId: owner.userId,
    credentialID: device.credentialID,
    publicKey: device.publicKey,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });
  await db
    .insert(twoFactorMethods)
    .values({ userId: owner.userId, method: 'passkey', isDefault: true });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, owner.userId));
  const flow = await startGoogle({
    sub: 'amr-review-subject',
    email: owner.email,
    amr,
  });
  const response = await flow.callback();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(
    bypass ? { data: { loggedIn: true } } : { twoFactorRedirect: true }
  );
  if (bypass) {
    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, owner.userId));
    expect(events).toContainEqual(
      expect.objectContaining({
        newData: expect.objectContaining({
          reason: 'two_factor_skipped_google_mfa',
        }),
      })
    );
  }
});

test.each([0, 60_000])(
  'rotation rejects an already-proven password even when the app clock is ahead by %d ms',
  async (skew) => {
    const owner = await seedUser();
    const { cookie } = await signIn(owner);
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    if (!live) throw new Error('Missing fixture session.');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mint = adminReauth.mintAdminReauth;
    const paused = spyOn(adminReauth, 'mintAdminReauth').mockImplementation(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return mint(...args);
      }
    );
    const now = Date.now;
    const clock = spyOn(Date, 'now').mockImplementation(() => now() + skew);
    const pending = call('/api/dash/auth/reauth', cookie, {
      password: owner.password,
    });
    try {
      await entered.promise;
      clock.mockRestore();
      const rotated = await call('/api/dash/users/me/change-password', cookie, {
        currentPassword: owner.password,
        newPassword: 'Rotated!Password123',
      });
      expect(rotated.status).toBe(200);
      expect(
        await db.select().from(sessions).where(eq(sessions.id, live.session.id))
      ).toHaveLength(1);
      release.resolve();
      await expect(pending).resolves.toHaveProperty('status', 401);
      expect(
        await adminReauth.hasAdminReauth(live.session.id, owner.userId)
      ).toBe(false);
    } finally {
      clock.mockRestore();
      release.resolve();
      await pending;
      paused.mockRestore();
      dropMockedClockWindows();
    }
  }
);

test.each(['reauth', 'two-factor'])(
  'concurrent verified assertions preserve the highest counter in %s',
  async (mode) => {
    const owner = await seedUser();
    const device = syntheticAuthenticator();
    await db.insert(passkeys).values({
      userId: owner.userId,
      credentialID: device.credentialID,
      publicKey: device.publicKey,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    });
    let cookie: string;
    if (mode === 'reauth') ({ cookie } = await signIn(owner));
    else {
      await db
        .insert(twoFactorMethods)
        .values({ userId: owner.userId, method: 'passkey', isDefault: true });
      await db
        .update(users)
        .set({ twoFactorEnabled: true })
        .where(eq(users.id, owner.userId));
      const flow = await startGoogle({
        sub: 'counter-subject',
        email: owner.email,
      });
      const response = await flow.callback();
      cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
    }
    const options = await call(`/api/auth/${mode}/passkey/options`, cookie, {});
    const { data } = z
      .object({ data: z.object({ challenge: z.string() }) })
      .parse(await options.json());
    const verify = passkeyAssertion.verifyUserPasskey;
    const concurrent = spyOn(
      passkeyAssertion,
      'verifyUserPasskey'
    ).mockImplementation(async (...args) => {
      const result = await verify(...args);
      await db
        .update(passkeys)
        .set({ counter: 9 })
        .where(eq(passkeys.id, result.credential.id));
      return result;
    });
    try {
      const response = await call(`/api/auth/${mode}/passkey/verify`, cookie, {
        response: device.assertion({
          challenge: data.challenge,
          origin: PUBLIC_ORIGIN,
          rpId: new URL(PUBLIC_ORIGIN).hostname,
          counter: 4,
        }),
      });
      expect(response.status).toBe(200);
      const [credential] = await db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, owner.userId));
      expect(credential?.counter).toBe(9);
    } finally {
      concurrent.mockRestore();
    }
  }
);

test('a passkey removed after challenge resolution keeps the established 2FA options status', async () => {
  const owner = await seedUser();
  const device = syntheticAuthenticator();
  await db.insert(passkeys).values({
    userId: owner.userId,
    credentialID: device.credentialID,
    publicKey: device.publicKey,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });
  await db
    .insert(twoFactorMethods)
    .values({ userId: owner.userId, method: 'passkey', isDefault: true });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, owner.userId));
  const flow = await startGoogle({
    sub: 'removed-passkey-subject',
    email: owner.email,
  });
  const challenged = await flow.callback();
  const cookie = mergeCookies(flow.cookie, challenged.headers.getSetCookie());
  const options = passkeyAssertion.passkeyOptions;
  const removed = spyOn(passkeyAssertion, 'passkeyOptions').mockImplementation(
    async (...args) => {
      await db.delete(passkeys).where(eq(passkeys.userId, owner.userId));
      return options(...args);
    }
  );
  try {
    await expect(
      call('/api/auth/two-factor/passkey/options', cookie, {})
    ).resolves.toHaveProperty('status', 400);
  } finally {
    removed.mockRestore();
  }
});

test('a redirected Google sign-in that needs local 2FA delivers the CHALLENGE, not a 401', async () => {
  // `GET /oauth/result` asked only for `success === true`, and the callback
  // stores the two-factor envelope — which carries `twoFactorRedirect` and no
  // `success`. So the documented redirected flow answered 401 to every account
  // with a second factor, after consuming both records: unrecoverable, with no
  // retry. The direct (no `callbackURL`) branch was unaffected, which is why
  // nothing here saw it.
  const owner = await seedUser({
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

  const flow = await startGoogle(
    { sub: 'redirected-two-factor', email: owner.email },
    { callbackURL: '/finish' }
  );
  const redirected = await flow.callback();
  expect(redirected.status).toBe(302);

  const cookie = mergeCookies(flow.cookie, redirected.headers.getSetCookie());
  const result = await call('/api/auth/oauth/result', cookie);

  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    twoFactorRedirect: true,
    twoFactorMethods: ['otp'],
  });

  // Still single-use: the records were consumed by the read above.
  await expect(call('/api/auth/oauth/result', cookie)).resolves.toHaveProperty(
    'status',
    401
  );
});

type GoogleFlow = Awaited<ReturnType<typeof startGoogle>>;
type Answer = () => Response | Promise<Response>;

interface CallbackScript {
  claims?: Record<string, unknown>;
  token?: string;
  tamper?: (token: string) => string;
  query?: Record<string, string | null>;
  arrange?: (flow: GoogleFlow) => void | Promise<void>;
}

/** One scripted callback, answered in the direct mode and in the callbackURL mode. */
async function answerInBothModes(script: CallbackScript) {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const outcomes = [];
    for (const callbackURL of [undefined, '/finish']) {
      log.mockClear();
      warning.mockClear();
      const owner = await seedUser();
      const flow = await startGoogle(
        { sub: 'review-subject', email: owner.email, ...script.claims },
        { callbackURL, token: script.token, tamper: script.tamper }
      );
      await script.arrange?.(flow);
      const response = await flow.callback(script.query);
      outcomes.push({
        flow,
        response,
        errors: log.mock.calls.map(([line]) => line),
        warnings: warning.mock.calls.map(([line]) => line),
      });
    }
    return outcomes;
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
}

async function expectNothingGranted() {
  expect(await db.select().from(sessions)).toHaveLength(0);
  expect(
    await db.select().from(accounts).where(eq(accounts.providerId, 'google'))
  ).toHaveLength(0);
}

async function expectProviderFault(
  script: CallbackScript,
  expected: { stage: string; reason: string }
) {
  const outcomes = await answerInBothModes(script);
  for (const outcome of outcomes) {
    expect(outcome.response.status).toBe(500);
    expect(outcome.response.headers.get('location')).toBeNull();
    expect(
      outcome.response.headers
        .getSetCookie()
        .some((cookie) => cookie.includes('oauth_result'))
    ).toBe(false);
    expect(await outcome.response.json()).toMatchObject({
      message: MSG_INTERNAL_ERROR,
    });
    expect(outcome.errors).toEqual([
      {
        msg: 'oauth.signIn.failed',
        provider: 'google',
        errorClass: 'GoogleProviderFault',
        ...expected,
      },
    ]);
    expect(outcome.warnings).toEqual([]);
  }
  const stored = await db
    .select({ identifier: verifications.identifier })
    .from(verifications);
  expect(
    stored.filter(({ identifier }) => identifier.startsWith('oauth-result'))
  ).toEqual([]);
  await expectNothingGranted();
}

async function expectRefusal(
  script: CallbackScript,
  expected: { stage: string; reason: string }
) {
  const [direct, redirected] = await answerInBothModes(script);
  expect(direct?.response.status).toBe(401);
  const refusal = await direct?.response.json();
  expect(refusal).toMatchObject({ message: MSG_INVALID_CREDENTIALS });
  expect(redirected?.response.status).toBe(302);
  expect(redirected?.response.headers.get('location')).toBe(
    `${PUBLIC_ORIGIN}/finish`
  );
  const result = await call(
    '/api/auth/oauth/result',
    mergeCookies(
      redirected?.flow.cookie ?? '',
      redirected?.response.headers.getSetCookie() ?? []
    )
  );
  expect(result.status).toBe(401);
  expect(await result.json()).toEqual(refusal);
  for (const outcome of [direct, redirected]) {
    expect(outcome?.warnings).toEqual([
      { msg: 'oauth.signIn.failed', provider: 'google', ...expected },
    ]);
    expect(outcome?.errors).toEqual([]);
  }
  await expectNothingGranted();
}

function answerTokenEndpoint(answer: Answer) {
  return () => scriptEgress('oauth2.googleapis.com', answer);
}

function answerKeySet(answer: Answer) {
  return () => scriptEgress('www.googleapis.com', answer);
}

function unreachable(): never {
  throw new TypeError('fetch failed');
}

test.each([
  ['an empty JSON object', () => Response.json({})],
  [
    'an HTML page',
    () =>
      new Response('<html>proxy</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  ],
  ['an empty body', () => new Response('', { status: 200 })],
  ['a numeric id_token', () => Response.json({ id_token: 123 })],
  ['an object id_token', () => Response.json({ id_token: { jwt: 'x' } })],
  ['an array id_token', () => Response.json({ id_token: ['a.b.c'] })],
  ['an empty id_token', () => Response.json({ id_token: '' })],
  ['an access token alone', () => Response.json({ access_token: 'a' })],
] as [string, Answer][])(
  'a 200 token answer with %s is a provider fault, not a refused sign-in',
  (_label, answer) =>
    expectProviderFault(
      { arrange: answerTokenEndpoint(answer) },
      { stage: 'token_exchange', reason: 'token_response_malformed' }
    )
);

test.each([
  ['a 500', () => new Response('error', { status: 500 })],
  ['a 404', () => new Response('missing', { status: 404 })],
  [
    'a redirect',
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/certs' },
      }),
  ],
  ['a network failure', unreachable],
  ['an empty key set', () => Response.json({ keys: [] })],
  ['an object without keys', () => Response.json({})],
  ['a non-JSON body', () => new Response('<html></html>', { status: 200 })],
  ['keys that are not an array', () => Response.json({ keys: 'x' })],
  [
    'a member with the right key id and no key material',
    () =>
      Response.json({
        keys: [{ kty: 'RSA', kid: 'harness-google', alg: 'RS256', use: 'sig' }],
      }),
  ],
] as [string, Answer][])(
  'a key set fetch that is %s is a provider fault, not a refused sign-in',
  (_label, answer) =>
    expectProviderFault(
      { arrange: answerKeySet(answer) },
      { stage: 'token_verification', reason: 'signing_keys_unavailable' }
    )
);

function rewriteHeader(change: (header: Record<string, unknown>) => unknown) {
  return (token: string) => {
    const [header = '', ...rest] = token.split('.');
    const parsed = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.from(header, 'base64url').toString()));
    return [
      Buffer.from(JSON.stringify(change(parsed))).toString('base64url'),
      ...rest,
    ].join('.');
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

test.each([
  [
    'a corrupted signature',
    {
      tamper: (token: string) => {
        const at = token.length - 20;
        return `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
      },
    },
  ],
  [
    'the wrong audience',
    { claims: { aud: 'other.apps.googleusercontent.com' } },
  ],
  ['the wrong issuer', { claims: { iss: 'https://evil.example' } }],
  ['the wrong nonce', { claims: { nonce: 'not-this-flows-nonce' } }],
  [
    'an expired token',
    { claims: { iat: nowSeconds() - 100, exp: nowSeconds() - 10 } },
  ],
  [
    'a token older than an hour',
    { claims: { iat: nowSeconds() - 7200, exp: nowSeconds() + 600 } },
  ],
  ['no iat claim', { claims: { iat: undefined } }],
  [
    'a different authorized party',
    { claims: { azp: 'other.apps.googleusercontent.com' } },
  ],
  [
    'a key id the key set does not hold',
    { tamper: rewriteHeader((header) => ({ ...header, kid: 'rotated-away' })) },
  ],
  [
    'no key id',
    { tamper: rewriteHeader(({ kid: _kid, ...header }) => header) },
  ],
  [
    'an HS256 header',
    { tamper: rewriteHeader((header) => ({ ...header, alg: 'HS256' })) },
  ],
  [
    'alg none',
    { tamper: rewriteHeader((header) => ({ ...header, alg: 'none' })) },
  ],
  ['a string that is not a JWT', { token: 'not.a.jwt' }],
  ['a single segment', { token: 'x' }],
] as [string, CallbackScript][])(
  'an ID token with %s is a refusal that logs a warning, in both modes',
  (_label, script) =>
    expectRefusal(script, {
      stage: 'token_verification',
      reason: 'id_token_invalid',
    })
);

test('a key set holding only another key refuses the token instead of faulting', () =>
  expectRefusal(
    {
      arrange: answerKeySet(() =>
        Response.json({
          keys: [
            {
              ...crypto
                .generateKeyPairSync('rsa', { modulusLength: 2048 })
                .publicKey.export({ format: 'jwk' }),
              kid: 'harness-google',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        })
      ),
    },
    { stage: 'token_verification', reason: 'id_token_invalid' }
  ));

test.each([
  [
    'the user cancels',
    { code: null, error: 'access_denied' },
    'user_cancelled',
  ],
  [
    'Google reports another error',
    { code: null, error: 'server_error' },
    'authorization_error',
  ],
  [
    'an error accompanies a code',
    { error: 'invalid_scope' },
    'authorization_error',
  ],
  [
    'the issuer is not Google',
    { iss: 'https://untrusted.example' },
    'issuer_mismatch',
  ],
  ['the code is absent', { code: null }, 'code_missing'],
] as [string, Record<string, string | null>, string][])(
  'a callback where %s is a warning with its own reason, in both modes',
  (_label, query, reason) =>
    expectRefusal({ query }, { stage: 'state', reason })
);

test('a callback whose one-shot marker is already spent is a warning, in both modes', () =>
  expectRefusal(
    {
      arrange: async (flow) => {
        await db
          .delete(verifications)
          .where(
            eq(
              verifications.identifier,
              oauthOnceKey(flow.url.searchParams.get('state') ?? '')
            )
          );
      },
    },
    { stage: 'state', reason: 'state_replayed' }
  ));
