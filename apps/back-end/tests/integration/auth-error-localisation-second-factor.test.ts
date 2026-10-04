/**
 * `auth-error-localisation.test.ts` reaches only what an anonymous caller can,
 * which with TOTP, backup codes and passkeys enabled is the project's own gates.
 * The refusals that come from Better Auth's verifiers and from the passkey
 * plugin need a live challenge or a session, so they are driven here, with the
 * integration tier's method list (`TWO_FACTOR_TEST_ENV` in `helpers/run.ts`).
 *
 * Each case names the library code it provokes. The last block is the property
 * over the plugins' declared codes: one a dependency bump adds is either mapped
 * or accounted for here, before it can reach a client in English.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { passkeys, twoFactorCredentials } from '@/db/schema';
import { passkey } from '@better-auth/passkey';
import { symmetricDecrypt } from 'better-auth/crypto';
import { twoFactor } from 'better-auth/plugins/two-factor';

import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { betterAuthMsg, twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_NOT_FOUND } from '@app/shared/messages/common';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import { userMsg } from '@app/shared/messages/users';

import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { generateUuidV7 } from '@/lib/id';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';
import { buildRegistrationResponse } from '../helpers/webauthn';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const AUTH_URL = 'http://localhost/api/auth';
const WRONG_TOTP_CODE = '000000';
const WRONG_BACKUP_CODE = 'zzzzz-zzzzz';
const RP_ID = new URL(PUBLIC_ORIGIN).hostname;

const fixture: { user: SeededUser | null; secret: string } = {
  user: null,
  secret: '',
};

function enrolled(): SeededUser {
  if (!fixture.user) throw new Error('fixture not enrolled');
  return fixture.user;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  cookie?: string
): Promise<Response> {
  return app.handle(
    new Request(`${AUTH_URL}${path}`, {
      method,
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(cookie !== undefined && { cookie }),
      }),
      ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
    })
  );
}

/** The cookies a first-factor sign-in left: a challenge when 2FA is enrolled. */
async function signIn(user: SeededUser): Promise<string> {
  const response = await call('POST', '/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  expect(response.status).toBe(HTTP_STATUS.OK);
  return cookieHeader(response.headers.getSetCookie());
}

/** What a client receives: Arabic text, under the project's own code. */
function arabic(message: string): { message: string; code: string } {
  return { message, code: CUSTOM_AUTH_CODE };
}

async function expectAnswer(
  response: Response,
  status: number,
  message: string
): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(arabic(message));
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));

  const user = await seedUser();
  const cookie = await signIn(user);
  const started = await call(
    'POST',
    '/two-factor/totp/start',
    { password: user.password },
    cookie
  );
  expect(started.status).toBe(HTTP_STATUS.OK);

  // The stored secret, not the one in the URI: the verifier takes the raw value.
  const [credential] = await db
    .select({ secret: twoFactorCredentials.secret })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, user.userId));
  if (!credential) throw new Error('start stored no TOTP credential');
  const secret = await symmetricDecrypt({
    key: process.env.BETTER_AUTH_SECRET ?? '',
    data: credential.secret,
  });
  const { code } = await auth.api.generateTOTP({ body: { secret } });
  const confirmed = await call(
    'POST',
    '/two-factor/totp/confirm',
    { code },
    cookie
  );
  expect(confirmed.status).toBe(HTTP_STATUS.OK);

  // The backup-code verifier is offered only once a set is acknowledged.
  const session = cookieHeader(confirmed.headers.getSetCookie()) || cookie;
  const generated = await call(
    'POST',
    '/two-factor/generate-backup-codes',
    { password: user.password },
    session
  );
  expect(generated.status).toBe(HTTP_STATUS.OK);
  const setId = ((await generated.json()) as { data?: { setId?: string } }).data
    ?.setId;
  const acknowledged = await call(
    'POST',
    '/two-factor/backup-codes/acknowledge',
    { password: user.password, setId },
    session
  );
  expect(acknowledged.status).toBe(HTTP_STATUS.OK);

  fixture.user = user;
  fixture.secret = secret;
});

// The account lockout and the per-challenge budget are per credential and
// outlive a case; a later case would answer 429 instead of its own refusal.
afterEach(async () => {
  /* eslint-disable-next-line drizzle/enforce-update-with-where -- every
     credential row in the harness database, deliberately: this file enrols one */
  await db
    .update(twoFactorCredentials)
    .set({ failedVerificationCount: 0, lockedUntil: null });
});

describe('the verifiers answer a refusal in Arabic', () => {
  test('INVALID_CODE: a wrong TOTP code', async () => {
    const challenge = await signIn(enrolled());
    await expectAnswer(
      await call(
        'POST',
        '/two-factor/verify-totp',
        { code: WRONG_TOTP_CODE },
        challenge
      ),
      HTTP_STATUS.UNAUTHORIZED,
      twoFactorMsg.invalidCode
    );
  });

  test('INVALID_BACKUP_CODE: a wrong backup code', async () => {
    const challenge = await signIn(enrolled());
    await expectAnswer(
      await call(
        'POST',
        '/two-factor/verify-backup-code',
        { code: WRONG_BACKUP_CODE },
        challenge
      ),
      HTTP_STATUS.UNAUTHORIZED,
      twoFactorMsg.invalidCode
    );
  });

  test('TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: the challenge budget is spent', async () => {
    const challenge = await signIn(enrolled());
    // The budget is five attempts; the sixth finds it spent.
    for (let attempt = 0; attempt < 5; attempt++)
      await call(
        'POST',
        '/two-factor/verify-totp',
        { code: WRONG_TOTP_CODE },
        challenge
      );
    await expectAnswer(
      await call(
        'POST',
        '/two-factor/verify-totp',
        { code: WRONG_TOTP_CODE },
        challenge
      ),
      HTTP_STATUS.BAD_REQUEST,
      twoFactorMsg.tooManyAttempts
    );
  });

  test('ACCOUNT_TEMPORARILY_LOCKED: the credential is locked', async () => {
    const challenge = await signIn(enrolled());
    await db
      .update(twoFactorCredentials)
      .set({ lockedUntil: new Date(Date.now() + 15 * 60_000) })
      .where(eq(twoFactorCredentials.userId, enrolled().userId));
    await expectAnswer(
      await call(
        'POST',
        '/two-factor/verify-totp',
        { code: WRONG_TOTP_CODE },
        challenge
      ),
      HTTP_STATUS.TOO_MANY_REQUESTS,
      userMsg.accountTemporarilyLocked
    );
  });

  test('TOTP_NOT_ENABLED: a session with no TOTP asks for its URI', async () => {
    const user = await seedUser();
    const cookie = await signIn(user);
    await expectAnswer(
      await call(
        'POST',
        '/two-factor/get-totp-uri',
        { password: user.password },
        cookie
      ),
      HTTP_STATUS.BAD_REQUEST,
      twoFactorMsg.methodUnavailable
    );
  });
});

describe('the passkey endpoints answer a refusal in Arabic', () => {
  test('PASSKEY_NOT_FOUND: an unknown passkey is renamed', async () => {
    const user = await seedUser();
    const cookie = await signIn(user);
    await expectAnswer(
      await call(
        'POST',
        '/passkey/update-passkey',
        { id: generateUuidV7(), name: 'renamed' },
        cookie
      ),
      HTTP_STATUS.NOT_FOUND,
      MSG_NOT_FOUND
    );
  });

  test('YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: another account’s passkey is renamed', async () => {
    const owner = await seedUser();
    const [foreign] = await db
      .insert(passkeys)
      .values({
        userId: owner.userId,
        credentialID: 'localisation-foreign-credential',
        publicKey: Buffer.from('not-a-real-key').toString('base64'),
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      })
      .returning({ id: passkeys.id });
    if (!foreign) throw new Error('no passkey row written');

    const intruder = await seedUser();
    await expectAnswer(
      await call(
        'POST',
        '/passkey/update-passkey',
        { id: foreign.id, name: 'renamed' },
        await signIn(intruder)
      ),
      HTTP_STATUS.UNAUTHORIZED,
      MSG_INSUFFICIENT_PERMISSIONS
    );
  });

  /** A registration that reaches the plugin: signed in, with a grant spent. */
  async function registration(user: SeededUser, issueOptions: boolean) {
    const cookie = await signIn(user);
    const granted = await call(
      'POST',
      '/two-factor/passkey/grant',
      { password: user.password },
      cookie
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    const grant = ((await granted.json()) as { data?: { grant?: string } }).data
      ?.grant;

    let jar = cookie;
    if (issueOptions) {
      const options = await call(
        'GET',
        '/passkey/generate-register-options',
        undefined,
        cookie
      );
      expect(options.status).toBe(HTTP_STATUS.OK);
      jar = [cookie, cookieHeader(options.headers.getSetCookie())]
        .filter(Boolean)
        .join('; ');
    }
    const ceremony = buildRegistrationResponse({
      // Never the challenge the options request issued.
      challenge: 'a-challenge-the-server-did-not-issue',
      origin: PUBLIC_ORIGIN,
      rpId: RP_ID,
      userVerified: true,
    });
    return call(
      'POST',
      '/passkey/verify-registration',
      { response: ceremony.response, grant },
      jar
    );
  }

  test('CHALLENGE_NOT_FOUND: a ceremony nobody asked options for', async () => {
    await expectAnswer(
      await registration(await seedUser(), false),
      HTTP_STATUS.BAD_REQUEST,
      twoFactorMsg.passkeyNotSaved
    );
  });

  test('FAILED_TO_VERIFY_REGISTRATION: a ceremony signed for another challenge', async () => {
    const answer = await registration(await seedUser(), true);
    expect(answer.status).toBeOneOf([
      HTTP_STATUS.BAD_REQUEST,
      HTTP_STATUS.INTERNAL_ERROR,
    ]);
    expect(await answer.json()).toEqual(arabic(twoFactorMsg.passkeyNotSaved));
  });
});

/**
 * Codes the plugins declare that no mounted path can raise, and why. A code that
 * becomes reachable moves to `betterAuthMsg`; the check below refuses one that
 * is in both.
 */
const UNREACHABLE: Readonly<Record<string, string>> = {
  OTP_NOT_ENABLED:
    'the plugin OTP is unconfigured; its endpoints are not mounted',
  OTP_NOT_CONFIGURED:
    'the plugin OTP is unconfigured; its endpoints are not mounted',
  OTP_HAS_EXPIRED:
    'the plugin OTP is unconfigured; its endpoints are not mounted',
  TOTP_NOT_CONFIGURED:
    'raised only with TOTP disabled, when the allow-list already answers 404',
  TOTP_ALREADY_ENABLED: '`/two-factor/enable` is never served',
  AUTHENTICATION_FAILED:
    'the plugin sign-in endpoints are removed from the map',
  UNABLE_TO_CREATE_SESSION:
    'authentication endpoints are removed and registration never creates a session',
  PREVIOUSLY_REGISTERED: 'raised by the browser client, not by an endpoint',
  REGISTRATION_CANCELLED: 'raised by the browser client, not by an endpoint',
  AUTH_CANCELLED: 'raised by the browser client, not by an endpoint',
  RESOLVE_USER_REQUIRED:
    'registration requires a session; `resolveUser` is unset',
  RESOLVED_USER_INVALID:
    'registration requires a session; `resolveUser` is unset',
};

describe('every code the second-factor plugins declare is accounted for', () => {
  const declared = Object.keys({
    ...twoFactor({ twoFactorTable: 'twoFactorCredentials' }).$ERROR_CODES,
    ...passkey().$ERROR_CODES,
  });

  test.each(declared)('%s is mapped, or unreachable with a reason', (code) => {
    expect(
      Object.hasOwn(betterAuthMsg, code) || Object.hasOwn(UNREACHABLE, code)
    ).toBe(true);
  });

  test('the unreachable list names declared codes, and none that is mapped', () => {
    for (const code of Object.keys(UNREACHABLE)) {
      expect(declared).toContain(code);
      expect(Object.hasOwn(betterAuthMsg, code)).toBe(false);
    }
  });
});
