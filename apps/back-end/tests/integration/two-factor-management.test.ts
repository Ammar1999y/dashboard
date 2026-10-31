/**
 * The rules that decide when a second factor may be taken away, and by whom:
 * the last-method refusal, the backup-code acknowledgement gate, the recovery
 * refusal, and the `resetTwoFactor` grant.
 *
 * Each is asserted with its opposite, which is what proves it is a rule rather
 * than a blanket refusal.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  passkeys,
  sessions,
  trustedDevices,
  twoFactorCredentials,
  twoFactorMethods,
  users,
  verifications,
} from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_NOT_FOUND } from '@app/shared/messages/common';
import { otpMsg } from '@app/shared/messages/otp';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';

import { TWO_FACTOR_LOCKOUT_MAX_FAILURES } from '@/lib/auth/recovery/second-factor';
import { totpEnrolmentKey } from '@/lib/auth/verifications';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { getRateLimitStore } from '@/lib/rate-limit/store';

import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import { egressCallsTo, scriptEgress } from '../helpers/egress';
import { flooredBudget, replaceOtpCode, sentRequester } from '../helpers/otp';
import { resetRateLimits } from '../helpers/rate-limit';
import { baseHeaders, seedUser, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';
import { recordStatements } from '../helpers/statements';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const RIGHT_CODE = '515151';
const NEW_PASSWORD = 'Recovered-Pass-1!';
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? '';

/**
 * A working TOTP enrolment written directly, and the secret to drive it.
 *
 * The enrolment ENDPOINTS are covered in `two-factor-totp.test.ts`; what this
 * file needs is the resulting state, and going through five requests per fixture
 * would spend the shared admission budget on setup.
 */
async function enrolTotpBySql(userId: string): Promise<string> {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await db
    .insert(twoFactorCredentials)
    .values({
      userId,
      secret: await symmetricEncrypt({ key: BETTER_AUTH_SECRET, data: secret }),
      backupCodes: await symmetricEncrypt({
        key: BETTER_AUTH_SECRET,
        data: '[]',
      }),
      verified: true,
    })
    .onConflictDoNothing();
  await enrol(userId, 'totp');
  return secret;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

async function expectEnrolmentExpired(response: Response): Promise<void> {
  expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  expect(((await response.json()) as { message?: string }).message).toBe(
    twoFactorMsg.totpEnrolmentExpired
  );
}

function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  cookie?: string
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(cookie !== undefined && { cookie }),
      }),
      ...(method !== 'GET' && { body: JSON.stringify(body ?? {}) }),
    })
  );
}

/**
 * Signs in and opens the administrator re-authentication window.
 *
 * Every actor in this file goes on to perform an action that asks for a fresh
 * password proof — the
 * administrative edit, the reset — and those require a FRESH password proof, not
 * merely a session. The window is bound to the session, so nothing has to be
 * threaded through the request afterwards.
 */
async function signInCookie(
  user: SeededUser,
  reauthenticate = true
): Promise<string> {
  const response = await call('POST', '/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  const cookie = cookieHeader(response.headers.getSetCookie());
  if (!reauthenticate) return cookie;
  const reauth = await call(
    'POST',
    '/api/dash/auth/reauth',
    { password: user.password },
    cookie
  );
  if (reauth.status !== HTTP_STATUS.OK)
    throw new Error(`re-authentication returned ${reauth.status}`);
  return cookie;
}

async function enrol(
  userId: string,
  method: 'totp' | 'otp' | 'passkey' | 'backup_code',
  channel: 'sms' | 'email' | null = null
) {
  await db
    .insert(twoFactorMethods)
    .values({ userId, method, channel })
    .onConflictDoNothing();
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, userId));
}

async function methodsOf(userId: string) {
  const rows = await db
    .select({ method: twoFactorMethods.method })
    .from(twoFactorMethods)
    .where(eq(twoFactorMethods.userId, userId));
  // Explicit comparator: these are ASCII method names, so a locale-aware
  // collation would be the surprise. Same rule the other suites follow.
  return rows.map((row) => row.method).toSorted(compareCodeUnits);
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));
  // The recovery second factor is delivered by SMS here.
  scriptEgress('apis.deewan.sa', () => Response.json({ success: true }));
});

// Nearly every test signs in, and a fast run fits more of them into one per-IP
// window than the sign-in budget allows.
beforeEach(resetRateLimits);

describe('removing one method', () => {
  test('is allowed while another remains, and refused for the last', async () => {
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    // Signed in FIRST: once a second factor is enrolled, a sign-in answers with
    // a challenge rather than a session, and these endpoints need a session.
    // A real user reaches them by completing their second factor; the fixture
    // reaches the same state by holding a session from before enrolment.
    const cookie = await signInCookie(user, false);
    // A VERIFIED TOTP, not an intent row alone: the removal below is allowed
    // only because a factor a challenge would offer survives it.
    await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'sms');

    // A session is not enough: removing a factor is a security-state change,
    // and without the password a hijacked session strips factors with no proof.
    // `contactKind` is required for `otp`: an sms enrolment is the PHONE
    // possession, and a user may hold an email one at the same time.
    const unproven = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp', contactKind: 'phone' },
      cookie
    );
    expect(unproven.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await methodsOf(user.userId)).toEqual(['otp', 'totp']);

    const removed = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp', contactKind: 'phone', password: user.password },
      cookie
    );
    expect(removed.status).toBe(HTTP_STATUS.OK);
    expect(await removed.json()).toMatchObject({
      data: { removedMethod: 'otp:phone' },
    });
    expect(await methodsOf(user.userId)).toEqual(['totp']);

    // The last one. Refused with 409, not silently accepted and not silently
    // turning 2FA off — either would leave the user believing something that is
    // no longer true.
    const last = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'totp', password: user.password },
      cookie
    );
    expect(last.status).toBe(HTTP_STATUS.CONFLICT);
    expect(await methodsOf(user.userId)).toEqual(['totp']);
  });

  test('names the OTP destination even when the user holds only one', async () => {
    // The rule is unconditional, and this is the case that pays for it: one
    // enrolment makes the request unambiguous, and it is still refused. A
    // schema that were "optional unless ambiguous" would make the SAME body
    // valid or invalid depending on state the client cannot see, and the
    // handlers resolved an unqualified `otp` by ORDER — so a user holding both
    // lost whichever row sorted first. One shape, always.
    //
    // 422 carries `methodUnavailable`, the same text as the 404 for a method the
    // user has not enrolled; `docs/two-factor-flow.md` §6 records that.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    const cookie = await signInCookie(user, false);
    await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'sms');

    const unqualified = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp', password: user.password },
      cookie
    );
    expect(unqualified.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(await methodsOf(user.userId)).toEqual(['otp', 'totp']);

    // The default-method endpoint shares the schema, so it shares the refusal —
    // and it is the one action in this area that needs no password, so a reader
    // cannot infer the rule from the removal case alone.
    const unqualifiedDefault = await call(
      'POST',
      '/api/auth/two-factor/methods/default',
      { method: 'otp' },
      cookie
    );
    expect(unqualifiedDefault.status).toBe(HTTP_STATUS.UNPROCESSABLE);

    // Its opposite: with the contact named it is a reorder, and needs no proof.
    const qualifiedDefault = await call(
      'POST',
      '/api/auth/two-factor/methods/default',
      { method: 'otp', contactKind: 'phone' },
      cookie
    );
    expect(qualifiedDefault.status).toBe(HTTP_STATUS.OK);
    expect(await qualifiedDefault.json()).toEqual({
      data: { defaultMethod: 'otp:phone' },
    });
    const defaults = await db
      .select({ method: twoFactorMethods.method })
      .from(twoFactorMethods)
      .where(
        and(
          eq(twoFactorMethods.userId, user.userId),
          eq(twoFactorMethods.isDefault, true)
        )
      );
    expect(defaults).toEqual([{ method: 'otp' }]);
  });

  test('is refused when the surviving row is not a factor a challenge would offer', async () => {
    // ⚠️ Counting intent rows let a user strand themselves through the
    // supported path: an `otp:email` row whose contact is no longer verified is
    // still a row, so removing the working TOTP passed the "not the last" check
    // and left the account 2FA-on with an empty offered set — the state the
    // administrative reset exists to exit, reached by doing the ordinary thing.
    const user = await seedUser();
    const cookie = await signInCookie(user);
    await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'email');
    await db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, user.userId));

    const stranding = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'totp', password: user.password },
      cookie
    );
    expect(stranding.status).toBe(HTTP_STATUS.CONFLICT);
    expect(await methodsOf(user.userId)).toEqual(['otp', 'totp']);

    // Removing the row that is NOT a factor is cleanup, and is allowed.
    const cleanup = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp', contactKind: 'email', password: user.password },
      cookie
    );
    expect(cleanup.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['totp']);
  });

  test('a removed authenticator cannot be re-confirmed without a fresh start', async () => {
    // Removal kept the sessions and the encrypted secret, and `confirm` takes no
    // password — so whoever held a live session and the old authenticator app
    // turned TOTP back on and signed the owner out of every other device.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    const cookie = await signInCookie(user, false);
    const oldSecret = await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'sms');

    const removed = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'totp', password: user.password },
      cookie
    );
    expect(removed.status).toBe(HTTP_STATUS.OK);

    // The secret goes too, not only the pending start: with it kept, a start
    // row left over from before would let the old app confirm again.
    const [cleared] = await db
      .select({
        secret: twoFactorCredentials.secret,
        verified: twoFactorCredentials.verified,
      })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, user.userId));
    expect(cleared?.verified).toBe(false);
    expect(
      await symmetricDecrypt({
        key: BETTER_AUTH_SECRET,
        data: cleared?.secret ?? '',
      })
    ).not.toBe(oldSecret);

    const oldCode = await createOTP(oldSecret).totp();
    const reconfirmed = await call(
      'POST',
      '/api/auth/two-factor/totp/confirm',
      { code: oldCode },
      cookie
    );
    await expectEnrolmentExpired(reconfirmed);
    expect(await methodsOf(user.userId)).toEqual(['otp']);

    // The opposite: after the password-gated `start`, the NEW secret confirms.
    const started = await call(
      'POST',
      '/api/auth/two-factor/totp/start',
      { password: user.password },
      cookie
    );
    expect(started.status).toBe(HTTP_STATUS.OK);
    const [credential] = await db
      .select({ secret: twoFactorCredentials.secret })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, user.userId));
    if (!credential) throw new Error('start stored no TOTP credential');
    const newCode = await createOTP(
      await symmetricDecrypt({
        key: BETTER_AUTH_SECRET,
        data: credential.secret,
      })
    ).totp();
    const confirmed = await call(
      'POST',
      '/api/auth/two-factor/totp/confirm',
      { code: newCode },
      cookie
    );
    expect(confirmed.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['otp', 'totp']);
  });
});

describe('confirming TOTP with no start pending', () => {
  /**
   * The placeholder a removal or a backup-code-only row leaves is random, but
   * `confirm` has no lockout, so a session holder could guess against it. The
   * placeholder's OWN code is the strongest guess there is.
   */
  async function placeholderCode(userId: string): Promise<string> {
    const [credential] = await db
      .select({ secret: twoFactorCredentials.secret })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, userId));
    if (!credential) throw new Error('no TOTP credential row');
    const code = await createOTP(
      await symmetricDecrypt({
        key: BETTER_AUTH_SECRET,
        data: credential.secret,
      })
    ).totp();
    return code;
  }

  test('is refused after a removal, even with the placeholder’s own code', async () => {
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    const cookie = await signInCookie(user, false);
    await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'sms');

    const removed = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'totp', password: user.password },
      cookie
    );
    expect(removed.status).toBe(HTTP_STATUS.OK);

    const confirmed = await call(
      'POST',
      '/api/auth/two-factor/totp/confirm',
      { code: await placeholderCode(user.userId) },
      cookie
    );
    await expectEnrolmentExpired(confirmed);
    expect(await methodsOf(user.userId)).toEqual(['otp']);
  });

  test('is refused on a backup-code-only row, even with the placeholder’s own code', async () => {
    const user = await seedUser();
    const cookie = await signInCookie(user, false);

    const generated = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    expect(generated.status).toBe(HTTP_STATUS.OK);

    const confirmed = await call(
      'POST',
      '/api/auth/two-factor/totp/confirm',
      { code: await placeholderCode(user.userId) },
      cookie
    );
    await expectEnrolmentExpired(confirmed);
    expect(await methodsOf(user.userId)).toEqual([]);
  });

  test('is refused once the start has expired, even with the new secret’s code', async () => {
    const user = await seedUser();
    const cookie = await signInCookie(user, false);

    const started = await call(
      'POST',
      '/api/auth/two-factor/totp/start',
      { password: user.password },
      cookie
    );
    expect(started.status).toBe(HTTP_STATUS.OK);
    await db
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verifications.identifier, totpEnrolmentKey(user.userId)));

    const confirmed = await call(
      'POST',
      '/api/auth/two-factor/totp/confirm',
      { code: await placeholderCode(user.userId) },
      cookie
    );
    await expectEnrolmentExpired(confirmed);
    expect(await methodsOf(user.userId)).toEqual([]);
  });
});

describe('backup codes', () => {
  test('are not a usable method until the user acknowledges them', async () => {
    const user = await seedUser();
    const cookie = await signInCookie(user, false);

    const enabled = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    expect(enabled.status).toBe(HTTP_STATUS.OK);
    const setId = ((await enabled.json()) as { data?: { setId?: string } }).data
      ?.setId;
    expect(setId).toBeString();

    // The set exists in the database...
    const [credential] = await db
      .select({
        backupCodes: twoFactorCredentials.backupCodes,
        acknowledgedAt: twoFactorCredentials.backupCodesAcknowledgedAt,
      })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, user.userId));
    expect(credential?.backupCodes).toBeTruthy();
    // ...and is deliberately not yet an enrolled method.
    expect(credential?.acknowledgedAt).toBeNull();
    expect(await methodsOf(user.userId)).toEqual([]);

    // Acknowledging flips the flag and evicts every other session, so a
    // session alone is not enough for it — a hijacked one could otherwise turn
    // the feature on and sign the owner out of every device in one call.
    const unproven = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { setId },
      cookie
    );
    expect(unproven.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await methodsOf(user.userId)).toEqual([]);

    const acknowledged = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId },
      cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['backup_code']);
  });

  /** Every password `verifyLoginAttempt` has actually checked for this user. */
  async function passwordProofs(userId: string): Promise<unknown[]> {
    const rows = await db
      .select({ newData: auditLogs.newData })
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId));
    return rows.filter(
      (row) =>
        (row.newData as { purpose?: unknown } | null)?.purpose ===
        'reauth_two_factor'
    );
  }

  test('a body with no set id is a validation failure, not a stale-set answer', async () => {
    // Two things at once. The ANSWER: an omitted `setId` used to be told the
    // set was no longer current, which points a client at regenerating codes it
    // never needed to regenerate. The ORDER: the parse runs before
    // `requireReauthPassword`, so a malformed body cannot buy an Argon2id
    // verification. The status alone cannot show that — it is 422 either way —
    // so the ORDER is read from the audit row a completed verification writes.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);
    const generated = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    expect(generated.status).toBe(HTTP_STATUS.OK);
    // That generation DID prove the password, which is what makes the count
    // below a real observation rather than a table that is empty anyway.
    const before = await passwordProofs(user.userId);
    expect(before.length).toBeGreaterThan(0);

    for (const body of [
      { password: user.password },
      { password: user.password, setId: '' },
      { password: user.password, setId: 'not-a-uuid' },
    ]) {
      const answer = await call(
        'POST',
        '/api/auth/two-factor/backup-codes/acknowledge',
        body,
        cookie
      );
      expect([body, answer.status]).toEqual([body, HTTP_STATUS.UNPROCESSABLE]);
      expect((await answer.json()) as { message?: string }).toMatchObject({
        message: otpMsg.invalidInput,
      });
    }

    // Three correct passwords supplied, none verified.
    expect(await passwordProofs(user.userId)).toHaveLength(before.length);
    expect(await methodsOf(user.userId)).toEqual([]);
  });

  test('a set id is not reused after the credential row is deleted and remade', async () => {
    // The counter this replaced restarted. `/two-factor/disable` deletes the
    // credential row and KEEPS the caller's session, so the next generation
    // inserts a fresh row — and a per-row sequence hands its first set the same
    // name as the first set of the row before it. An older tab's
    // acknowledgement then matched, enabled codes the user never saw, and
    // revoked every other session doing it.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);

    const generate = async () => {
      const generated = await call(
        'POST',
        '/api/auth/two-factor/generate-backup-codes',
        { password: user.password },
        cookie
      );
      expect(generated.status).toBe(HTTP_STATUS.OK);
      const body = (await generated.json()) as { data?: { setId?: string } };
      return body.data?.setId;
    };

    const savedSetId = await generate();
    expect(savedSetId).toBeString();

    const disabled = await call(
      'POST',
      '/api/auth/two-factor/disable',
      { password: user.password },
      cookie
    );
    expect(disabled.status).toBe(HTTP_STATUS.OK);
    expect(
      await db
        .select({ id: twoFactorCredentials.id })
        .from(twoFactorCredentials)
        .where(eq(twoFactorCredentials.userId, user.userId))
    ).toEqual([]);

    const remadeSetId = await generate();
    expect(remadeSetId).not.toBe(savedSetId);

    const stale = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: savedSetId },
      cookie
    );
    expect(stale.status).toBe(HTTP_STATUS.CONFLICT);
    expect(await methodsOf(user.userId)).toEqual([]);

    const current = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: remadeSetId },
      cookie
    );
    expect(current.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['backup_code']);
  });

  test('acknowledging a set another tab has already replaced is refused', async () => {
    // Two tabs. A saves set 1, B regenerates into set 2, A confirms. The
    // acknowledgement used to land on whatever was current, so the method was
    // enabled, every other session revoked, and the ten codes the user actually
    // wrote down all answered 401 — a backup-code-only account stranded by a
    // success message.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);

    const tabA = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    const savedSetId = ((await tabA.json()) as { data?: { setId?: string } })
      .data?.setId;

    const tabB = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    const currentSetId = ((await tabB.json()) as { data?: { setId?: string } })
      .data?.setId;
    expect(currentSetId).not.toBe(savedSetId);

    const stale = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: savedSetId },
      cookie
    );
    expect(stale.status).toBe(HTTP_STATUS.CONFLICT);
    // Nothing was enabled, and no session was revoked over it.
    expect(await methodsOf(user.userId)).toEqual([]);

    // The set that actually exists still acknowledges.
    const current = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: currentSetId },
      cookie
    );
    expect(current.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['backup_code']);
  });
});

describe('regenerating backup codes', () => {
  async function trustOf(userId: string) {
    return db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, userId));
  }

  async function generate(user: SeededUser, cookie: string) {
    const response = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    return ((await response.json()) as { data?: { setId?: string } }).data
      ?.setId;
  }

  async function trustDevice(userId: string) {
    await db.insert(trustedDevices).values({
      userId,
      trustIdentifier: `trust-device-harness-${userId}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  }

  test('revokes trust a replaced, acknowledged set could have earned', async () => {
    // Regenerating is what a user does when the sheet leaked; trust a leaked
    // code earned would otherwise outlive it.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);
    const setId = await generate(user, cookie);
    const acknowledged = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId },
      cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);
    await trustDevice(user.userId);

    await generate(user, cookie);
    expect(await trustOf(user.userId)).toBeEmpty();
  });

  test('keeps trust when the replaced set was never offered', async () => {
    // A set never acknowledged was never a sign-in factor, so it earned no trust.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);
    await trustDevice(user.userId);

    await generate(user, cookie);
    await generate(user, cookie);
    expect(await trustOf(user.userId)).toHaveLength(1);
  });

  test('replacing an offered set leaves a backup-code-only user able to sign in before acknowledging', async () => {
    // The acknowledgement may never land (a closed tab). Held back for it, the
    // new set left this user with nothing to sign in with.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);
    const firstSetId = await generate(user, cookie);
    const acknowledged = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: firstSetId },
      cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);
    const generateCodes = async () => {
      const response = await call(
        'POST',
        '/api/auth/two-factor/generate-backup-codes',
        { password: user.password },
        cookie
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      const body = (await response.json()) as {
        data?: { backupCodes?: string[] };
      };
      return body.data?.backupCodes ?? [];
    };
    const oldCodes = await generateCodes();
    // Replaced again, and this set is never acknowledged.
    const codes = await generateCodes();
    expect(codes.length).toBeGreaterThan(0);
    expect(oldCodes.length).toBeGreaterThan(0);

    const challenged = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: user.password,
    });
    expect(challenged.status).toBe(HTTP_STATUS.OK);
    expect(await challenged.json()).toMatchObject({
      twoFactorMethods: ['backup_code'],
    });
    const challenge = cookieHeader(challenged.headers.getSetCookie());

    // The replaced set stopped working when it was replaced.
    const sessionsBefore = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, user.userId));
    const stale = await call(
      'POST',
      '/api/auth/two-factor/verify-backup-code',
      { code: oldCodes[0] },
      challenge
    );
    expect(stale.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, user.userId))
    ).toEqual(sessionsBefore);

    const completed = await call(
      'POST',
      '/api/auth/two-factor/verify-backup-code',
      { code: codes[0] },
      challenge
    );
    expect(completed.status).toBe(HTTP_STATUS.OK);
  });

  test('an unconfirmed replacement is never left as the only factor', async () => {
    // Offered at sign-in, but the user may have discarded it: removing the
    // factor they did save is refused until they confirm the new set.
    const user = await seedUser();
    // Signed in first: an enrolled account answers a challenge.
    const cookie = await signInCookie(user, false);
    await enrolTotpBySql(user.userId);
    const firstSetId = await generate(user, cookie);
    const acknowledged = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: firstSetId },
      cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);
    const replacedSetId = await generate(user, cookie);

    const removeTotp = () =>
      call(
        'POST',
        '/api/auth/two-factor/methods/disable',
        { method: 'totp', password: user.password },
        cookie
      );
    const refused = await removeTotp();
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    expect(await methodsOf(user.userId)).toEqual(['backup_code', 'totp']);

    const confirmed = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: replacedSetId },
      cookie
    );
    expect(confirmed.status).toBe(HTTP_STATUS.OK);
    const removed = await removeTotp();
    expect(removed.status).toBe(HTTP_STATUS.OK);
  });

  test('an unconfirmed replacement does not block a change that takes nothing relied on', async () => {
    // Backup codes are the only method and no OTP is enrolled: changing the
    // email removes no factor, confirmed or not.
    const user = await seedUser();
    const cookie = await signInCookie(user, false);
    const acknowledged = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password, setId: await generate(user, cookie) },
      cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);
    await generate(user, cookie);

    const changed = await call(
      'POST',
      '/api/dash/users/me/change-email',
      {
        currentPassword: user.password,
        newEmail: `unconfirmed.${user.userId.slice(-8)}@gmail.com`,
      },
      cookie
    );
    expect(changed.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['backup_code']);
  });
});

describe('password recovery against a second factor', () => {
  /** Drives recovery to the point of the reset, with a code this file knows. */
  async function attemptReset(user: SeededUser): Promise<Response> {
    const sent = await call('POST', '/api/auth/forgot-password/send', {
      channel: 'email',
      email: user.email,
    });
    const { requester, cookie } = sentRequester(sent);
    await replaceOtpCode({
      userId: user.userId,
      purpose: 'forgot_password',
      contactKind: 'email',
      code: RIGHT_CODE,
      requester,
    });

    return call(
      'POST',
      '/api/auth/forgot-password/reset',
      {
        channel: 'email',
        email: user.email,
        code: RIGHT_CODE,
        newPassword: NEW_PASSWORD,
      },
      cookie
    );
  }

  test(
    'is refused when every factor is an OTP to the recovery contact',
    async () => {
      const user = await seedUser();
      // The collapse: recovery reaches the mailbox, and so does the only second
      // factor. Whoever holds that mailbox holds both — and requiring the second
      // factor here would not help, because they can prove it too.
      await enrol(user.userId, 'otp', 'email');

      const response = await attemptReset(user);
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      // The password is UNCHANGED, which is the property: the refusal is what
      // keeps the account two-factor.
      const stillOld = await call('POST', '/api/auth/sign-in/email', {
        email: user.email,
        password: user.password,
      });
      expect(stillOld.status).toBe(HTTP_STATUS.OK);
    },
    flooredBudget(2)
  );

  test(
    'does not write the password on the recovery code alone',
    async () => {
      // ⚠️ The finding. Recovery by email, second factor by SMS: the possessions
      // are disjoint, so the reset is not REFUSED — but it also may not proceed on
      // the mailbox alone. It answers a grant, and the password is untouched until
      // the surviving factor is proven against it.
      const user = await seedUser({
        phoneNumber: uniquePhone(),
        phoneNumberVerified: true,
      });
      await enrol(user.userId, 'otp', 'sms');

      const response = await attemptReset(user);
      expect(response.status).toBe(HTTP_STATUS.OK);
      const body = (await response.json()) as {
        data?: {
          reset?: boolean;
          twoFactorRequired?: boolean;
          grant?: string;
          options?: { id: string }[];
        };
      };
      expect(body.data?.reset).toBe(false);
      expect(body.data?.twoFactorRequired).toBe(true);
      expect(body.data?.grant).toBeString();
      expect(body.data?.options?.map((option) => option.id)).toEqual([
        'otp:phone',
      ]);

      // The old password still works, which is the property: a mailbox alone did
      // not rewrite it.
      const stillOld = await call('POST', '/api/auth/sign-in/email', {
        email: user.email,
        password: user.password,
      });
      expect(stillOld.status).toBe(HTTP_STATUS.OK);
    },
    flooredBudget(2)
  );

  test(
    'reads the enrolment state once, under the user lock',
    async () => {
      const user = await seedUser({
        phoneNumber: uniquePhone(),
        phoneNumberVerified: true,
      });
      await enrol(user.userId, 'otp', 'sms');

      const recorder = recordStatements();
      const response = await attemptReset(user).finally(recorder.stop);
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(
        recorder.matching(
          /"two_factor_methods"|"two_factor_credentials"|"passkeys"/
        )
      ).toHaveLength(1);
    },
    flooredBudget(2)
  );

  test('completes only against a proven second factor', async () => {
    const user = await seedUser();
    const secret = await enrolTotpBySql(user.userId);

    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();

    // The grant is NOT sufficient alone: a wrong code leaves the password where
    // it was, and the grant survives for the user's next try rather than the
    // attacker's.
    const wrong = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code: '000000',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).not.toBe(HTTP_STATUS.OK);
    const beforeChange = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: NEW_PASSWORD,
    });
    expect(beforeChange.status).not.toBe(HTTP_STATUS.OK);

    const code = await createOTP(secret).totp();
    const completed = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code,
      newPassword: NEW_PASSWORD,
    });
    expect(completed.status).toBe(HTTP_STATUS.OK);

    // And the grant is single-use, so a replay cannot rewrite it again.
    const replayCode = await createOTP(secret).totp();
    const replayed = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code: replayCode,
      newPassword: 'Another-Pass-1!',
    });
    expect(replayed.status).not.toBe(HTTP_STATUS.OK);

    const withNew = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: NEW_PASSWORD,
    });
    // A challenge, not a session: the reset changed the password and left the
    // second factor exactly where it was.
    expect(await withNew.json()).toMatchObject({ twoFactorRedirect: true });
    // Five recovery requests, each floored at `MINIMUM_RESPONSE_MS` so the
    // anonymous paths cannot be timed. The default 5 s budget is the harness's,
    // not a statement about this flow.
  }, 30_000);

  test('charges the grant budget for guesses only', async () => {
    // The grant's five attempts are the same budget the sign-in challenge has,
    // under the same rule: a code that was COMPARED and lost is a guess; a
    // request that never reached a comparison — here, a completion before any
    // second-factor code was sent, so no proof row exists — is refunded. The
    // completion handler charged every throw.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(user.userId, 'otp', 'sms');

    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();
    const attemptsOf = async () => {
      const [row] = await db
        .select({ value: verifications.value })
        .from(verifications)
        .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
      return row?.value;
    };
    expect(await attemptsOf()).toBe('0');

    const early = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'otp:phone',
      code: RIGHT_CODE,
      newPassword: NEW_PASSWORD,
    });
    expect(early.status).not.toBe(HTTP_STATUS.OK);
    expect(await attemptsOf()).toBe('0');

    // With a code in flight, a wrong one IS a guess.
    const sent = await call(
      'POST',
      '/api/auth/forgot-password/second-factor/send',
      { grant, option: 'otp:phone' }
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    const wrong = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'otp:phone',
      code: '000000',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).not.toBe(HTTP_STATUS.OK);
    expect(await attemptsOf()).toBe('1');
  }, 30_000);

  test('refunds a TOTP check that never reached a comparison', async () => {
    // The checks that answer by RETURNING rather than throwing carry the same
    // distinction as a verdict: a secret that cannot be decrypted — a rotated
    // key — compared nothing, and five of those must not burn the grant.
    const user = await seedUser();
    await enrolTotpBySql(user.userId);

    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();
    await db
      .update(twoFactorCredentials)
      .set({ secret: 'not-a-ciphertext' })
      .where(eq(twoFactorCredentials.userId, user.userId));

    const unavailable = await call(
      'POST',
      '/api/auth/forgot-password/complete',
      { grant, option: 'totp', code: '000000', newPassword: NEW_PASSWORD }
    );
    expect(unavailable.status).not.toBe(HTTP_STATUS.OK);
    const [row] = await db
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
    expect(row?.value).toBe('0');
  }, 30_000);

  test('honours the account-wide 2FA lockout sign-in enforces', async () => {
    // The lock lives on the credential row both flows verify against. Recovery
    // ignoring it gave a holder of the recovery mailbox a second, unlocked
    // guessing budget.
    const user = await seedUser();
    const secret = await enrolTotpBySql(user.userId);
    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();
    const credentialOf = async () => {
      const [row] = await db
        .select({
          count: twoFactorCredentials.failedVerificationCount,
          lockedUntil: twoFactorCredentials.lockedUntil,
          lastTotpStep: twoFactorCredentials.lastTotpStep,
        })
        .from(twoFactorCredentials)
        .where(eq(twoFactorCredentials.userId, user.userId));
      return row;
    };

    await db
      .update(twoFactorCredentials)
      .set({
        failedVerificationCount: TWO_FACTOR_LOCKOUT_MAX_FAILURES,
        lockedUntil: new Date(Date.now() + 15 * 60_000),
      })
      .where(eq(twoFactorCredentials.userId, user.userId));
    const lockedBefore = await credentialOf();

    const code = await createOTP(secret).totp();
    const locked = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code,
      newPassword: NEW_PASSWORD,
    });
    expect(locked.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(locked.headers.get('retry-after')).toBeString();
    // Nothing committed: the password, the grant's budget, the lock and the
    // TOTP step are all as they were, so the code is still usable later.
    const withNew = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: NEW_PASSWORD,
    });
    expect(withNew.status).not.toBe(HTTP_STATUS.OK);
    const [attempts] = await db
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
    expect(attempts?.value).toBe('0');
    expect(await credentialOf()).toEqual(lockedBefore);

    // One failure short of the lock, a wrong code reaches it.
    await db
      .update(twoFactorCredentials)
      .set({
        failedVerificationCount: TWO_FACTOR_LOCKOUT_MAX_FAILURES - 1,
        lockedUntil: null,
      })
      .where(eq(twoFactorCredentials.userId, user.userId));
    const wrong = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code: '000000',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const after = await credentialOf();
    expect(after?.count).toBe(TWO_FACTOR_LOCKOUT_MAX_FAILURES);
    expect(after?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  test('spends the reset hash budget on every completion', async () => {
    // A completion that compared nothing refunds its grant attempt, so without
    // this charge one grant replayed the Argon2 hash and breach lookup for free.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(user.userId, 'otp', 'sms');
    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();
    const hashBudgetSpent = (): number => {
      const statement = getRateLimitStore().db.prepare(
        'SELECT count FROM rate_limit WHERE key LIKE ?'
      );
      try {
        return statement
          .all<{ count: number }>('%forgot.reset.work.ip%')
          .reduce((total, row) => total + row.count, 0);
      } finally {
        statement.finalize();
      }
    };
    const before = hashBudgetSpent();

    for (let replay = 0; replay < 2; replay++) {
      const early = await call('POST', '/api/auth/forgot-password/complete', {
        grant,
        option: 'otp:phone',
        code: RIGHT_CODE,
        newPassword: NEW_PASSWORD,
      });
      expect(early.status).not.toBe(HTTP_STATUS.OK);
    }
    expect(hashBudgetSpent()).toBe(before + 2);

    // Spent: refused before the breach lookup and the hash, with nothing written.
    getRateLimitStore().db.exec(
      "UPDATE rate_limit SET count = 1000 WHERE key LIKE '%forgot.reset.work.ip%'"
    );
    const lookups = egressCallsTo('api.pwnedpasswords.com').length;
    const refused = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'otp:phone',
      code: RIGHT_CODE,
      newPassword: NEW_PASSWORD,
    });
    expect(refused.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(egressCallsTo('api.pwnedpasswords.com')).toHaveLength(lookups);
    const [attempts] = await db
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
    expect(attempts?.value).toBe('0');
  }, 30_000);
});

describe('an administrative contact change against a second factor', () => {
  // A separate actor: the target has 2FA on, so its own sign-in returns a
  // challenge rather than a session.
  async function editPhone(
    actor: SeededUser,
    target: SeededUser,
    phoneNumber: string
  ) {
    return call(
      'PUT',
      `/api/dash/users/${target.userId}`,
      {
        name: 'Renamed By Harness',
        email: target.email,
        roleId: target.roleId,
        isActive: true,
        phoneNumber,
      },
      await signInCookie(actor)
    );
  }

  test('is refused when it would take the target’s last usable factor', async () => {
    const admin = await seedUser();
    const phone = uniquePhone();
    const target = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');

    // Repointing the phone clears `phone_number_verified`, which takes the OTP
    // method out of the offered set. That used to leave the account with 2FA on
    // and nothing to prove it with — a downgrade before step 0, a lockout
    // after.
    const refused = await editPhone(admin, target, uniquePhone());
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);

    // And nothing was written.
    const [row] = await db
      .select({ phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.phoneNumber).toBe(phone);
    expect(await methodsOf(target.userId)).toEqual(['otp']);
  });

  test('is allowed when another factor survives it', async () => {
    const admin = await seedUser();
    const target = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');
    await enrol(target.userId, 'totp');
    await db
      .insert(twoFactorCredentials)
      .values({
        userId: target.userId,
        secret: 'harness-secret',
        backupCodes: 'harness-codes',
        verified: true,
      })
      .onConflictDoNothing();

    // TOTP is bound to no contact, so the change costs the account nothing it
    // cannot still prove.
    const allowed = await editPhone(admin, target, uniquePhone());
    expect(allowed.status).toBe(HTTP_STATUS.OK);
  });

  test('asks ONE question when a request changes both contacts', async () => {
    // ⚠️ The predicate used to be asked per changed kind against UNMODIFIED
    // state, so a request changing both passed both checks — email survived
    // because phone still counted, phone survived because email still counted —
    // and stranded the target anyway. Exact only while a user could hold one OTP
    // enrolment; with two it is the whole finding.
    const admin = await seedUser();
    const phone = uniquePhone();
    const target = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');
    await enrol(target.userId, 'otp', 'email');

    const refused = await call(
      'PUT',
      `/api/dash/users/${target.userId}`,
      {
        name: 'Renamed By Harness',
        email: `moved.${target.email}`,
        roleId: target.roleId,
        isActive: true,
        phoneNumber: uniquePhone(),
      },
      await signInCookie(admin)
    );
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);

    const [row] = await db
      .select({ email: users.email, phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.email).toBe(target.email);
    expect(row?.phoneNumber).toBe(phone);
  });

  test('detaches the OTP enrolment from a contact it moved', async () => {
    // Rule 3: the factor must not FOLLOW the address. The admin edit clears the
    // verified flag, but a later re-verification of the new address would re-arm
    // an enrolment pointed at a destination the user never chose.
    const admin = await seedUser();
    const target = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');
    await enrol(target.userId, 'totp');
    await db
      .insert(twoFactorCredentials)
      .values({
        userId: target.userId,
        secret: 'harness-secret',
        backupCodes: 'harness-codes',
        verified: true,
      })
      .onConflictDoNothing();

    const allowed = await editPhone(admin, target, uniquePhone());
    expect(allowed.status).toBe(HTTP_STATUS.OK);

    // The phone enrolment is gone and TOTP survives — and, rule 1, the flag is
    // untouched: `users.edit` is not a 2FA disarm.
    expect(await methodsOf(target.userId)).toEqual(['totp']);
    const [row] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.twoFactorEnabled).toBe(true);
  });
});

describe('the administrative reset', () => {
  test('clears everything, and only for a holder of the grant', async () => {
    const target = await seedUser();
    await enrol(target.userId, 'totp');

    // An admin with every permission EXCEPT the new one.
    const withoutGrant = await seedUser({
      permissions: {
        users: { view: true, edit: true, create: true, delete: true },
      },
    });
    const refused = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      await signInCookie(withoutGrant)
    );
    // `users.edit` is not enough. This is the whole reason it is its own
    // action: an admin who may correct a name may not disarm 2FA.
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await methodsOf(target.userId)).toEqual(['totp']);

    const withGrant = await seedUser();
    const allowed = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      await signInCookie(withGrant)
    );
    expect(allowed.status).toBe(HTTP_STATUS.OK);

    expect(await methodsOf(target.userId)).toEqual([]);
    const [row] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.twoFactorEnabled).toBe(false);
  });

  test('is refused without a FRESH password proof, self-target included', async () => {
    // ⚠️ A permission grant says the actor MAY disarm someone's second
    // factor; it does not say the person at the keyboard is still that actor.
    // This endpoint ran `requirePermission`, a rate limit, the visibility gate
    // and the role-scope gate, and called `verifyLoginAttempt` nowhere — while
    // `users/me/change-password` re-authenticated for something strictly less
    // dangerous.
    //
    // The SELF case is the sharp one: `assertTargetUserVisible` exempts self
    // from both its narrowings, so the cheapest self-disarm in the system was to
    // POST your own id from a hijacked session.
    const actor = await seedUser();

    // Signed in FIRST — an enrolled account answers a challenge rather than a
    // session — and NOT re-authenticated: `signInCookie` would open the window.
    const signedIn = await call('POST', '/api/auth/sign-in/email', {
      email: actor.email,
      password: actor.password,
    });
    const cookie = cookieHeader(signedIn.headers.getSetCookie());
    await enrol(actor.userId, 'totp');

    const unproven = await call(
      'POST',
      `/api/dash/users/${actor.userId}/two-factor/reset`,
      {},
      cookie
    );
    expect(unproven.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await methodsOf(actor.userId)).toEqual(['totp']);

    // The same request, after the password is proven on this session.
    const reauth = await call(
      'POST',
      '/api/dash/auth/reauth',
      { password: actor.password },
      cookie
    );
    expect(reauth.status).toBe(HTTP_STATUS.OK);

    const proven = await call(
      'POST',
      `/api/dash/users/${actor.userId}/two-factor/reset`,
      {},
      cookie
    );
    expect(proven.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(actor.userId)).toEqual([]);
  });

  test('is refused against a target whose role outranks the actor', async () => {
    // `resetTwoFactor` has no `Own` variant, so `resolveActionScope` answers
    // `scope: 'all'` and `assertTargetUserVisible`'s `createdBy` narrowing never
    // fires. Without the role-scope check every sibling under `/users/:id`
    // applies, an actor refused a `PUT` on this id could still strip its second
    // factor — the weaker gate on the more dangerous action.
    const target = await seedUser();
    await enrol(target.userId, 'totp');

    // ⚠️ `edit` is granted DELIBERATELY. Without it the `PUT` below is refused
    // for lacking `users.edit` at all and never reaches the role-scope gate, so
    // the assertion passed whatever that gate did — the agreement this test
    // exists to prove was untested.
    const narrowActor = await seedUser({
      permissions: { users: { view: true, edit: true, resetTwoFactor: true } },
    });

    const refused = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      await signInCookie(narrowActor)
    );
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(((await refused.json()) as { detail: string }).detail).toBe(
      MSG_INSUFFICIENT_PERMISSIONS
    );
    expect(await methodsOf(target.userId)).toEqual(['totp']);
    expect(await storedTarget(target.userId)).toEqual({
      name: 'Harness User',
      twoFactorEnabled: true,
    });

    // The same actor, holding `users.edit`, is refused the parent `PUT` on the
    // same id by the SAME gate, with the SAME answer.
    const edit = await call(
      'PUT',
      `/api/dash/users/${target.userId}`,
      {
        name: 'Renamed By Harness',
        email: target.email,
        roleId: target.roleId,
        isActive: true,
      },
      await signInCookie(narrowActor)
    );
    expect(edit.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(((await edit.json()) as { detail: string }).detail).toBe(
      MSG_INSUFFICIENT_PERMISSIONS
    );
    const after = await storedTarget(target.userId);
    expect(after?.name).toBe('Harness User');
  });

  test.each([
    ['no view grant', {}],
    ['only `viewOwn`', { viewOwn: true }],
  ])(
    'answers 404 to a caller with %s, who cannot read the target',
    async (_, view) => {
      // Created by nobody the caller is, so `viewOwn` does not reach it either.
      const target = await seedUser();
      await enrol(target.userId, 'totp');
      const resetOnly = await seedUser({
        permissions: { users: { ...view, resetTwoFactor: true } },
      });

      const refused = await call(
        'POST',
        `/api/dash/users/${target.userId}/two-factor/reset`,
        {},
        await signInCookie(resetOnly)
      );
      expect(refused.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(((await refused.json()) as { detail: string }).detail).toBe(
        MSG_NOT_FOUND
      );
      expect(await methodsOf(target.userId)).toEqual(['totp']);
    }
  );
});

async function storedTarget(userId: string) {
  const [row] = await db
    .select({ name: users.name, twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

test('deleting a user takes their second-factor enrolment and passkeys with it', async () => {
  // The row is soft-deleted and never purged, so nothing else ever would.
  const target = await seedUser();
  await enrolTotpBySql(target.userId);
  await enrol(target.userId, 'passkey');
  await db.insert(passkeys).values({
    userId: target.userId,
    credentialID: `deleted-user-credential-${target.userId}`,
    publicKey: Buffer.from('not-a-real-key').toString('base64'),
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });

  const deleted = await app.handle(
    new Request(`http://localhost/api/dash/users/${target.userId}`, {
      method: 'DELETE',
      headers: baseHeaders({
        origin: PUBLIC_ORIGIN,
        cookie: await signInCookie(await seedUser()),
      }),
    })
  );
  expect(deleted.status).toBe(HTTP_STATUS.OK);

  const rowsOf = async () => {
    const [user] = await db
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, target.userId));
    return {
      methods: await methodsOf(target.userId),
      credentials: await db
        .select({ id: twoFactorCredentials.id })
        .from(twoFactorCredentials)
        .where(eq(twoFactorCredentials.userId, target.userId)),
      passkeys: await db
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(eq(passkeys.userId, target.userId)),
      enabled: user?.enabled,
    };
  };
  expect(await rowsOf()).toEqual({
    methods: [],
    credentials: [],
    passkeys: [],
    enabled: false,
  });
});
