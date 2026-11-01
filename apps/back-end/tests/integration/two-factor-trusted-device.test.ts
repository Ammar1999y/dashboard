/**
 * Trusted devices — the only mechanism that skips the second factor.
 *
 * The pair that matters: a trusted device skips the challenge, and revoking it
 * brings the challenge back. Without the second half, "the challenge was
 * skipped" is indistinguishable from "2FA silently stopped working".
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  sessions,
  trustedDevices,
  twoFactorCredentials,
  twoFactorMethods,
} from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt } from 'better-auth/crypto';

import { HTTP_STATUS } from '@app/shared/http-status';

import { auth } from '@/lib/auth';
import * as trustedDevice from '@/lib/auth/two-factor/trusted-device';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables, waitForUserLock } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { replaceOtpCode } from '../helpers/otp';
import {
  baseHeaders,
  mergeCookies,
  seedUser,
  signedInUser,
} from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? '';
const USER_AGENT = 'Mozilla/5.0 (harness) TrustedDeviceTest/1.0';
const RIGHT_CODE = '424242';

const fixture: {
  user: SeededUser | null;
  secret: string;
  trusted: string;
  backupCodes: string[];
} = {
  user: null,
  secret: '',
  trusted: '',
  backupCodes: [],
};

function actor(): SeededUser {
  if (!fixture.user) throw new Error('fixture not seeded');
  return fixture.user;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

/**
 * A fresh source address per enrolment.
 *
 * The admission limiter is per IP, and a full enrolment is five requests. With
 * one address for the whole file, adding a test made an unrelated one 429 —
 * a coupling that has nothing to do with what either test asserts. Real users
 * do not share one address either.
 */
const nextTestIp = (() => {
  let n = 0;
  return () => {
    n += 1;
    return `203.0.113.${(n % 200) + 20}`;
  };
})();

function request(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  cookie?: string,
  ip?: string
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(ip && { 'cf-connecting-ip': ip }),
        // A real client always sends one, and it is what makes a listed device
        // recognisable. Asserting on it needs it to be here.
        'user-agent': USER_AGENT,
        ...(cookie !== undefined && { cookie }),
      }),
      ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
    })
  );
}

async function totpCode(secret = fixture.secret): Promise<string> {
  return createOTP(secret).totp();
}

interface SignInResult {
  body: Record<string, unknown>;
  cookie: string;
}

async function signIn(
  jar = '',
  user = actor(),
  ip?: string
): Promise<SignInResult> {
  const response = await request(
    'POST',
    '/api/auth/sign-in/email',
    { email: user.email, password: user.password },
    jar,
    ip
  );
  return {
    body: (await response.json()) as Record<string, unknown>,
    cookie: mergeCookies(jar, response.headers.getSetCookie()),
  };
}

/**
 * Enrols TOTP through the real endpoints and returns the verified jar.
 *
 * Extracted rather than seeded: this file is one of the two the verification
 * report named for writing final state by SQL, and that pattern is what let an
 * inert passkey enrolment ship green. A trusted device now requires a proven
 * second factor, so producing one legitimately is the only honest fixture — and
 * once the flow is a helper, a second user costs one call.
 */
async function enrolTotp(
  user: SeededUser,
  /** Only the fixture needs a set; every extra call spends the shared IP budget. */
  withBackupCodes = false
): Promise<{
  jar: string;
  secret: string;
  backupCodes: string[];
}> {
  const ip = nextTestIp();
  const first = await signIn('', user, ip);
  const start = await request(
    'POST',
    '/api/auth/two-factor/totp/start',
    { password: user.password },
    first.cookie,
    ip
  );
  if (start.status !== HTTP_STATUS.OK)
    throw new Error(`totp/start returned ${start.status}`);

  const secret = await storedTotpSecret(user);

  const confirm = await request(
    'POST',
    '/api/auth/two-factor/totp/confirm',
    { code: await totpCode(secret) },
    first.cookie,
    ip
  );
  if (confirm.status !== HTTP_STATUS.OK)
    throw new Error(`totp/confirm returned ${confirm.status}`);

  // Backup codes are their own method now, with their own generation and their
  // own acknowledgement — enrolling TOTP no longer mints a set as a side effect.
  const backupCodes = withBackupCodes
    ? await acknowledgeBackupCodes(user, first.cookie, ip)
    : [];

  return {
    jar: mergeCookies(first.cookie, confirm.headers.getSetCookie()),
    secret,
    backupCodes,
  };
}

async function storedTotpSecret(user: SeededUser): Promise<string> {
  const [credential] = await db
    .select({ secret: twoFactorCredentials.secret })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, user.userId));
  if (!credential) throw new Error('no TOTP credential stored');
  return symmetricDecrypt({ key: BETTER_AUTH_SECRET, data: credential.secret });
}

/** Generates a set and acknowledges it, which is what enables the method. */
async function acknowledgeBackupCodes(
  user: SeededUser,
  jar: string,
  ip: string
): Promise<string[]> {
  const generated = await request(
    'POST',
    '/api/auth/two-factor/generate-backup-codes',
    { password: user.password },
    jar,
    ip
  );
  if (generated.status !== HTTP_STATUS.OK)
    throw new Error(`generate-backup-codes returned ${generated.status}`);
  const generatedSet = (await generated.json()) as {
    data?: { backupCodes?: string[]; setId?: string };
  };
  const acknowledged = await request(
    'POST',
    '/api/auth/two-factor/backup-codes/acknowledge',
    { password: user.password, setId: generatedSet.data?.setId },
    jar,
    ip
  );
  if (acknowledged.status !== HTTP_STATUS.OK)
    throw new Error(`acknowledge returned ${acknowledged.status}`);
  return generatedSet.data?.backupCodes ?? [];
}

/**
 * Runs `verify` up to the point it issues its device-trust proof, removes a
 * method while it is held there, then lets both finish. Answers the verify.
 */
async function verifyRacingRemoval(
  verify: () => Promise<Response>,
  remove: () => Promise<Response>
): Promise<Response> {
  const issue = trustedDevice.markTwoFactorProven;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = spyOn(trustedDevice, 'markTwoFactorProven').mockImplementation(
    async (...args) => {
      entered.resolve();
      await release.promise;
      return issue(...args);
    }
  );
  try {
    const verifying = verify();
    await Promise.race([entered.promise, verifying]);
    const removing = remove();
    // Queued behind the verify's user lock, or, with none, already done.
    await Promise.race([removing, waitForUserLock()]);
    release.resolve();
    const [verified, removed] = await Promise.all([verifying, removing]);
    expect(verified.status).toBe(HTTP_STATUS.OK);
    expect(removed.status).toBe(HTTP_STATUS.OK);
    return verified;
  } finally {
    release.resolve();
    held.mockRestore();
  }
}

/** No trust can be minted on `jar`, and the next sign-in from it is challenged. */
async function expectNoTrustFor(user: SeededUser, jar: string): Promise<void> {
  const trusted = await request(
    'POST',
    '/api/auth/two-factor/trust-device',
    {},
    jar
  );
  expect(trusted.status).toBe(HTTP_STATUS.FORBIDDEN);
  expect(
    await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, user.userId))
  ).toHaveLength(0);
  const again = await signIn(
    mergeCookies(jar, trusted.headers.getSetCookie()),
    user
  );
  expect(again.body).toMatchObject({ twoFactorRedirect: true });
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));

  fixture.user = await seedUser();
  const enrolled = await enrolTotp(actor(), true);
  fixture.secret = enrolled.secret;
  fixture.trusted = enrolled.jar;
  fixture.backupCodes = enrolled.backupCodes;
});

describe('a hostile verification body', () => {
  test('cannot smuggle trustDevice or disableSession past the backup-code path', async () => {
    // Both flags are the caller's to set on the library's endpoint. `trustDevice`
    // would mint a record this application cannot list; `disableSession` consumes
    // the code and returns WITHOUT completing the challenge or re-arming the
    // attempt counter, spending a recovery code and bricking the challenge in one
    // call. The before hook forces both false.
    const code = fixture.backupCodes[0];
    expect(code).toBeDefined();

    const before = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, actor().userId));

    const attempt = await signIn();
    expect(attempt.body).toMatchObject({ twoFactorRedirect: true });

    const verified = await request(
      'POST',
      '/api/auth/two-factor/verify-backup-code',
      { code, trustDevice: true, disableSession: true },
      attempt.cookie
    );
    // `disableSession: false` won, so the challenge completed and a session
    // exists — the response is not the token-less shape the flag produces.
    expect(verified.status).toBe(HTTP_STATUS.OK);

    const jar = mergeCookies(attempt.cookie, verified.headers.getSetCookie());
    const session = await request(
      'GET',
      '/api/auth/get-session',
      undefined,
      jar
    );
    expect(await session.json()).not.toBeNull();

    // And `trustDevice: false` won, so nothing new was recorded.
    const after = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, actor().userId));
    expect(after).toHaveLength(before.length);
  });
});

describe('trusting a device', () => {
  test('records something the user can actually recognise', async () => {
    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      fixture.trusted
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    fixture.trusted = mergeCookies(
      fixture.trusted,
      granted.headers.getSetCookie()
    );

    const [row] = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, actor().userId));

    // The whole reason this is ours rather than the plugin's: its record holds
    // a user id and nothing else, so a settings screen could show a count and
    // no more.
    expect(row).toBeDefined();
    expect(row?.userAgent).toBe(USER_AGENT);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('is listed to its owner', async () => {
    const listed = await request(
      'GET',
      '/api/auth/two-factor/trusted-devices',
      undefined,
      fixture.trusted
    );
    expect(listed.status).toBe(HTTP_STATUS.OK);
    const body = (await listed.json()) as {
      data: { devices: { id: string }[] };
    };
    expect(body.data.devices).toHaveLength(1);
  });
});

describe('the skip, and taking it away', () => {
  test('a trusted device signs in without a challenge', async () => {
    const attempt = await signIn(fixture.trusted);

    // The pair's first half. `twoFactorRedirect` absent AND a session cookie
    // present — either alone would also match a broken 2FA that stopped
    // challenging anyone.
    expect(attempt.body.twoFactorRedirect).toBeUndefined();
    expect(attempt.cookie).toContain('session_token');
  });

  test('an untrusted device is still challenged', async () => {
    // Same credentials, no trust cookie. This is what proves the skip came from
    // the device record rather than from 2FA having quietly switched off.
    const attempt = await signIn();
    expect(attempt.body).toMatchObject({
      twoFactorRedirect: true,
      // TOTP leads: the system priority puts an authenticator ahead of recovery
      // material, and `defaultMethod` never routes to a backup code.
      twoFactorMethods: ['totp', 'backup_code'],
      defaultMethod: 'totp',
    });
  });

  test('revoking brings the challenge back on that same device', async () => {
    const listed = await request(
      'GET',
      '/api/auth/two-factor/trusted-devices',
      undefined,
      fixture.trusted
    );
    const body = (await listed.json()) as {
      data: { devices: { id: string }[] };
    };
    const target = body.data.devices[0];
    expect(target).toBeDefined();

    const revoked = await request(
      'POST',
      '/api/auth/two-factor/trusted-devices/revoke',
      { id: target?.id },
      fixture.trusted
    );
    expect(revoked.status).toBe(HTTP_STATUS.OK);

    const attempt = await signIn(fixture.trusted);
    expect(attempt.body).toMatchObject({ twoFactorRedirect: true });
  });

  test('a session that has not proven a second factor cannot be trusted', async () => {
    // The planting precondition, refused. A stolen session on an account with no
    // 2FA used to mint a 30-day skip that survived the victim later enabling it.
    const other = await seedUser();
    const otherSignIn = await request(
      'POST',
      '/api/auth/sign-in/email',
      { email: other.email, password: other.password },
      ''
    );
    const otherCookie = cookieHeader(otherSignIn.headers.getSetCookie());

    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      otherCookie
    );
    expect(granted.status).toBe(HTTP_STATUS.FORBIDDEN);

    const rows = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, other.userId));
    expect(rows).toHaveLength(0);
  });

  test('enrolling OTP proves a factor, so the browser that enrolled can be trusted', async () => {
    // As TOTP enrolment does. The opposite of the case above: the same
    // request, on a session that has just proven a code.
    const owner = await seedUser();
    const ip = nextTestIp();
    const first = await signIn('', owner, ip);
    const sent = await request(
      'POST',
      '/api/auth/two-factor/otp/send',
      { channel: 'email', password: owner.password },
      first.cookie,
      ip
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    await replaceOtpCode({
      userId: owner.userId,
      purpose: 'two_factor',
      contactKind: 'email',
      code: RIGHT_CODE,
    });
    const enrolled = await request(
      'POST',
      '/api/auth/two-factor/otp/verify',
      { code: RIGHT_CODE, channel: 'email' },
      first.cookie,
      ip
    );
    expect(enrolled.status).toBe(HTTP_STATUS.OK);

    const trusted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      mergeCookies(first.cookie, enrolled.headers.getSetCookie()),
      ip
    );
    expect(trusted.status).toBe(HTTP_STATUS.OK);
    expect(
      await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, owner.userId))
    ).toHaveLength(1);
  });

  test('the proof is single-use', async () => {
    // A second "remember this device" needs a second verification, so one
    // completed challenge cannot be replayed into any number of skips.
    const again = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      fixture.trusted
    );
    expect(again.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  test('a trusted device is refused once the account has no usable factor', async () => {
    // ⚠️ Ordering, and it is the whole finding. Device trust used to be consumed
    // BEFORE the offered set was computed, so exactly the population an
    // operator's method-list change strands kept signing in with the password
    // alone — indefinitely, on a 30-day grant made against a factor that no
    // longer exists — while every other holder of the same enrolment was
    // refused. The skip has to be a skip of a factor that is still there.
    const stranded = await seedUser();
    const enrolled = await enrolTotp(stranded);
    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    const trustedJar = mergeCookies(
      enrolled.jar,
      granted.headers.getSetCookie()
    );

    // The capability disappears; the intent row and `two_factor_enabled` stay,
    // which is precisely the state a dropped method or a deleted credential
    // leaves behind.
    await db
      .delete(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, stranded.userId));

    const refused = await request(
      'POST',
      '/api/auth/sign-in/email',
      { email: stranded.email, password: stranded.password },
      trustedJar
    );
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(cookieHeader(refused.headers.getSetCookie())).not.toContain(
      'session_token'
    );
  });

  test('removing a method revokes the proof that could mint a new trust', async () => {
    // ⚠️ Revoking the trusted-device ROWS is only half of it. The proof marker
    // is keyed by SESSION id, so a sweep on `value = userId` never reached it —
    // and method removal deliberately keeps the caller's session, which is
    // exactly where a surviving marker lets the same request mint a replacement
    // trusted device and undo the revocation it just performed.
    //
    // The marker is live here: enrolment proved a TOTP code on this session and
    // nothing has spent it, so a 403 below can only come from the removal.
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner, true);

    const removed = await request(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'backup_code', password: owner.password },
      enrolled.jar
    );
    expect(removed.status).toBe(HTTP_STATUS.OK);

    const again = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(again.status).toBe(HTTP_STATUS.FORBIDDEN);

    const rows = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, owner.userId));
    expect(rows).toHaveLength(0);
  });

  test('a trust request racing a method removal leaves no trust behind', async () => {
    // Paused with its proof already spent, as a slow request would be. Spent
    // and written outside the user lock, its row landed after the removal's
    // revocation and skipped the remaining factor at the next sign-in.
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner, true);
    const context = await auth.$context;
    const consume = context.internalAdapter.consumeVerificationValue;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const paused = spyOn(
      context.internalAdapter,
      'consumeVerificationValue'
    ).mockImplementation(async (...args) => {
      const consumed = await consume(...args);
      if (args[0].startsWith('2fa-proven-')) {
        entered.resolve();
        await release.promise;
      }
      return consumed;
    });
    let trusted: Response;
    try {
      const trusting = request(
        'POST',
        '/api/auth/two-factor/trust-device',
        {},
        enrolled.jar
      );
      await entered.promise;
      const removing = request(
        'POST',
        '/api/auth/two-factor/methods/disable',
        { method: 'backup_code', password: owner.password },
        enrolled.jar
      );
      // Queued behind the trust request's lock, or, with none, already done.
      await Promise.race([removing, waitForUserLock()]);
      release.resolve();
      const [trustAnswer, removed] = await Promise.all([trusting, removing]);
      trusted = trustAnswer;
      expect(removed.status).toBe(HTTP_STATUS.OK);
    } finally {
      release.resolve();
      paused.mockRestore();
    }

    expect(
      await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, owner.userId))
    ).toHaveLength(0);
    const again = await signIn(
      mergeCookies(enrolled.jar, trusted.headers.getSetCookie()),
      owner
    );
    expect(again.body).toMatchObject({ twoFactorRedirect: true });
  });

  test('a backup-code sign-in racing a method removal leaves no trust behind', async () => {
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner, true);
    const code = enrolled.backupCodes[0];
    expect(code).toBeDefined();
    const challenged = await signIn('', owner, nextTestIp());
    expect(challenged.body).toMatchObject({ twoFactorRedirect: true });

    const verified = await verifyRacingRemoval(
      () =>
        request(
          'POST',
          '/api/auth/two-factor/verify-backup-code',
          { code },
          challenged.cookie
        ),
      () =>
        request(
          'POST',
          '/api/auth/two-factor/methods/disable',
          { method: 'backup_code', password: owner.password },
          enrolled.jar
        )
    );

    await expectNoTrustFor(
      owner,
      mergeCookies(challenged.cookie, verified.headers.getSetCookie())
    );
  });

  test('a TOTP enrolment racing its removal leaves no trust behind', async () => {
    const owner = await seedUser();
    const ip = nextTestIp();
    const first = await signIn('', owner, ip);
    await acknowledgeBackupCodes(owner, first.cookie, ip);
    const started = await request(
      'POST',
      '/api/auth/two-factor/totp/start',
      { password: owner.password },
      first.cookie,
      ip
    );
    expect(started.status).toBe(HTTP_STATUS.OK);
    const secret = await storedTotpSecret(owner);

    const confirmed = await verifyRacingRemoval(
      async () =>
        request(
          'POST',
          '/api/auth/two-factor/totp/confirm',
          { code: await totpCode(secret) },
          first.cookie,
          ip
        ),
      () =>
        request(
          'POST',
          '/api/auth/two-factor/methods/disable',
          { method: 'totp', password: owner.password },
          first.cookie,
          ip
        )
    );

    await expectNoTrustFor(
      owner,
      mergeCookies(first.cookie, confirmed.headers.getSetCookie())
    );
  });

  test('an OTP sign-in racing a method removal leaves no trust behind', async () => {
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner, true);
    await db
      .insert(twoFactorMethods)
      .values({ userId: owner.userId, method: 'otp', channel: 'email' });
    const ip = nextTestIp();
    const challenged = await signIn('', owner, ip);
    expect(challenged.body).toMatchObject({ twoFactorRedirect: true });
    const sent = await request(
      'POST',
      '/api/auth/two-factor/otp/send',
      { option: 'otp:email' },
      challenged.cookie,
      ip
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    await replaceOtpCode({
      userId: owner.userId,
      purpose: 'two_factor',
      contactKind: 'email',
      code: RIGHT_CODE,
    });

    const verified = await verifyRacingRemoval(
      () =>
        request(
          'POST',
          '/api/auth/two-factor/otp/verify',
          { code: RIGHT_CODE },
          challenged.cookie,
          ip
        ),
      () =>
        request(
          'POST',
          '/api/auth/two-factor/methods/disable',
          { method: 'otp', contactKind: 'email', password: owner.password },
          enrolled.jar
        )
    );

    await expectNoTrustFor(
      owner,
      mergeCookies(challenged.cookie, verified.headers.getSetCookie())
    );
  });

  test('a device id that is not the caller’s is refused', async () => {
    const other = await seedUser();
    const otherEnrolled = await enrolTotp(other);
    const otherGrant = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      otherEnrolled.jar
    );
    expect(otherGrant.status).toBe(HTTP_STATUS.OK);

    const [victim] = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, other.userId));
    expect(victim).toBeDefined();

    const attempt = await request(
      'POST',
      '/api/auth/two-factor/trusted-devices/revoke',
      { id: victim?.id },
      fixture.trusted
    );
    expect(attempt.status).toBe(HTTP_STATUS.NOT_FOUND);

    // And it is still there.
    const [survivor] = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.id, victim?.id ?? ''));
    expect(survivor).toBeDefined();
  });
});

/**
 * Containment. `DELETE /api/dash/users/:id/sessions` with `revokeAll` is the
 * non-destructive action an operator reaches for on suspicious activity, and
 * a trusted device is the only thing in this system that skips the second
 * factor — keyed by its own cookie, outliving every session by design. Ending
 * the sessions and leaving the devices contained nothing: the password holder
 * signed straight back in, past 2FA, on the device they were already using.
 */
describe('bulk session revocation and the second-factor skip', () => {
  test('revokeAll takes the trusted devices with it', async () => {
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner);
    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    expect(
      await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, owner.userId))
    ).toHaveLength(1);

    // Full grant: `assertTargetReachable` refuses a target whose role carries
    // permissions the actor does not hold, which would be a 404 for a reason
    // this case is not about.
    const operator = await signedInUser();
    const revoked = await request(
      'POST',
      `/api/dash/users/${owner.userId}/sessions`,
      { revokeAll: true },
      operator.cookie
    );
    // The route is DELETE; `request` only speaks GET/POST, so go direct.
    expect(revoked.status).toBe(HTTP_STATUS.METHOD_NOT_ALLOWED);

    const deleted = await app.handle(
      new Request(`http://localhost/api/dash/users/${owner.userId}/sessions`, {
        method: 'DELETE',
        headers: baseHeaders({
          'content-type': 'application/json',
          origin: PUBLIC_ORIGIN,
          cookie: operator.cookie,
        }),
        body: JSON.stringify({ revokeAll: true }),
      })
    );
    expect(deleted.status).toBe(HTTP_STATUS.OK);

    expect(
      await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, owner.userId))
    ).toHaveLength(0);
  });

  test('revoking NAMED sessions leaves them, because that is housekeeping', async () => {
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner);
    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);

    const [live] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, owner.userId));
    expect(live).toBeDefined();

    // Full grant: `assertTargetReachable` refuses a target whose role carries
    // permissions the actor does not hold, which would be a 404 for a reason
    // this case is not about.
    const operator = await signedInUser();
    const deleted = await app.handle(
      new Request(`http://localhost/api/dash/users/${owner.userId}/sessions`, {
        method: 'DELETE',
        headers: baseHeaders({
          'content-type': 'application/json',
          origin: PUBLIC_ORIGIN,
          cookie: operator.cookie,
        }),
        body: JSON.stringify({ sessionIds: [live?.id] }),
      })
    );
    expect(deleted.status).toBe(HTTP_STATUS.OK);

    expect(
      await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, owner.userId))
    ).toHaveLength(1);
  });
});

/**
 * The one setting that skips the second factor for 30 days: who granted it,
 * which device used it and who revoked it must each leave a row. A browser
 * that trusts again holds only the new cookie, so the row its old cookie named
 * goes with it rather than lingering, unusable, in the list.
 */
describe('the trusted-device record', () => {
  function devicesOf(user: SeededUser) {
    return db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, user.userId));
  }

  function deviceEvents(user: SeededUser) {
    return db
      .select({
        action: auditLogs.action,
        recordId: auditLogs.recordId,
        newData: auditLogs.newData,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, user.userId),
          eq(auditLogs.tableName, 'trusted_devices')
        )
      );
  }

  test('a re-trust replaces the row the browser held, and grant, use and revocation are audited', async () => {
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner, true);
    const first = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(first.status).toBe(HTTP_STATUS.OK);
    const trustPair = mergeCookies(enrolled.jar, first.headers.getSetCookie())
      .split('; ')
      .find((pair) => pair.includes('trust_device='));
    expect(trustPair).toBeDefined();
    const [original] = await devicesOf(owner);
    expect(original).toBeDefined();

    // A fresh proof in the same browser, still presenting its trust cookie.
    const challenged = await signIn('', owner, nextTestIp());
    expect(challenged.body).toMatchObject({ twoFactorRedirect: true });
    const verified = await request(
      'POST',
      '/api/auth/two-factor/verify-backup-code',
      { code: enrolled.backupCodes[0] },
      challenged.cookie
    );
    expect(verified.status).toBe(HTTP_STATUS.OK);
    const again = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      `${mergeCookies(challenged.cookie, verified.headers.getSetCookie())}; ${trustPair}`
    );
    expect(again.status).toBe(HTTP_STATUS.OK);

    const devices = await devicesOf(owner);
    expect(devices).toHaveLength(1);
    const [replacement] = devices;
    expect(replacement?.id).not.toBe(original?.id);
    const granted = await deviceEvents(owner);
    expect(granted).toHaveLength(2);
    expect(granted).toContainEqual({
      action: 'INSERT',
      recordId: original?.id ?? '',
      newData: { deviceTrusted: true },
    });
    expect(granted).toContainEqual({
      action: 'INSERT',
      recordId: replacement?.id ?? '',
      newData: { deviceTrusted: true, replacedDeviceId: original?.id },
    });

    const trustedJar = mergeCookies(
      mergeCookies(challenged.cookie, verified.headers.getSetCookie()),
      again.headers.getSetCookie()
    );
    const skipped = await signIn(trustedJar, owner);
    expect(skipped.body.twoFactorRedirect).toBeUndefined();
    const skips = await db
      .select({ newData: auditLogs.newData })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, owner.userId),
          eq(auditLogs.tableName, 'sessions')
        )
      );
    expect(skips.map((row) => row.newData)).toContainEqual(
      expect.objectContaining({
        reason: 'two_factor_skipped_trusted_device',
        trustedDeviceId: replacement?.id,
      })
    );

    const revoked = await request(
      'POST',
      '/api/auth/two-factor/trusted-devices/revoke',
      { id: replacement?.id },
      trustedJar
    );
    expect(revoked.status).toBe(HTTP_STATUS.OK);
    expect(await devicesOf(owner)).toHaveLength(0);
    expect(await deviceEvents(owner)).toContainEqual({
      action: 'DELETE',
      recordId: replacement?.id ?? '',
      newData: { deviceTrusted: false },
    });
  });

  test('a malformed device id is refused before anything is read', async () => {
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner);
    const refused = await request(
      'POST',
      '/api/auth/two-factor/trusted-devices/revoke',
      { id: 'not-an-id' },
      enrolled.jar
    );
    expect(refused.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(await deviceEvents(owner)).toHaveLength(0);
  });
});

describe('the per-account cap', () => {
  test('a grant past it evicts the least recently used device, and audits it', async () => {
    const user = await seedUser();
    const enrolled = await enrolTotp(user, true);
    const seeded = await db
      .insert(trustedDevices)
      .values(
        Array.from({ length: trustedDevice.MAX_TRUSTED_DEVICES }, (_, n) => ({
          userId: user.userId,
          trustIdentifier: `seeded-${user.userId}-${n}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          // The first seeded row is the least recently used.
          lastUsedAt: new Date(Date.now() - (100 - n) * 60_000),
        }))
      )
      .returning({ id: trustedDevices.id });
    const oldest = seeded[0]?.id;

    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);

    const live = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, user.userId));
    expect(live).toHaveLength(trustedDevice.MAX_TRUSTED_DEVICES);
    expect(live.map((row) => row.id)).not.toContain(oldest);

    const [audit] = await db
      .select({ newData: auditLogs.newData })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, user.userId),
          eq(auditLogs.tableName, 'trusted_devices')
        )
      );
    expect(audit?.newData).toMatchObject({ evictedDeviceIds: [oldest] });
  });
});
