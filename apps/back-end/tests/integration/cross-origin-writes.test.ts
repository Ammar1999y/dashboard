/**
 * The origin check on table-route writes, judged by row state.
 *
 * A body-less POST is CORS-simple, and `SameSite=Lax` still sends the session
 * cookie on a same-site, cross-origin request, so a sibling subdomain could
 * disarm a user's second factor with an admin's cookie. The target's enrolment
 * surviving is the proof a refusal happened before the handler.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { twoFactorMethods, users } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';

import { CUSTOM_AUTH_CODE, MSG_UNTRUSTED_ORIGIN } from '@/lib/auth/errors';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import { baseHeaders, seedUser, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const SIBLING_ORIGIN = 'https://media.example.com';
const CROSS_SITE_ORIGIN = 'https://attacker.example';

interface Fixture {
  admin: SignedInSession;
  targetId: string;
}

const fixture: { current: Fixture | null } = { current: null };

function seeded(): Fixture {
  if (!fixture.current) throw new Error('fixture not seeded');
  return fixture.current;
}

beforeAll(async () => {
  await resetTables();
  resetSqliteStores();
  const admin = await signedInUser();
  const target = await seedUser();
  fixture.current = { admin, targetId: target.userId };
});

beforeEach(async () => {
  const { targetId } = seeded();
  await db
    .insert(twoFactorMethods)
    .values({ userId: targetId, method: 'totp', channel: null })
    .onConflictDoNothing();
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, targetId));
});

async function methodsOfTarget(): Promise<string[]> {
  const { targetId } = seeded();
  const rows = await db
    .select({ method: twoFactorMethods.method })
    .from(twoFactorMethods)
    .where(eq(twoFactorMethods.userId, targetId));
  return rows.map((row) => row.method);
}

/** The body-less POST the finding names, carrying the admin's session. */
function resetTarget(headers: Record<string, string>): Promise<Response> {
  const { admin, targetId } = seeded();
  return app.handle(
    new Request(
      `http://localhost/api/dash/users/${targetId}/two-factor/reset`,
      {
        method: 'POST',
        headers: baseHeaders({ cookie: admin.cookie, ...headers }),
      }
    )
  );
}

describe('a table-route write from another origin is refused', () => {
  test.each<[string, Record<string, string>]>([
    [
      'a same-site sibling origin',
      { origin: SIBLING_ORIGIN, 'sec-fetch-site': 'same-site' },
    ],
    [
      'a cross-site origin',
      { origin: CROSS_SITE_ORIGIN, 'sec-fetch-site': 'cross-site' },
    ],
    ['an untrusted Origin with no fetch metadata', { origin: SIBLING_ORIGIN }],
    ['Origin: null', { origin: 'null' }],
    ['fetch metadata alone', { 'sec-fetch-site': 'same-site' }],
    [
      'the trusted Origin sent from another origin',
      { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-site' },
    ],
  ])('%s', async (_label, headers) => {
    const response = await resetTarget(headers);

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await response.json()).toEqual({
      success: false,
      message: MSG_UNTRUSTED_ORIGIN,
      data: null,
    });
    expect(await methodsOfTarget()).toEqual(['totp']);
  });
});

describe('the callers the check must not touch', () => {
  test('a same-origin browser request proceeds', async () => {
    const response = await resetTarget({
      origin: PUBLIC_ORIGIN,
      'sec-fetch-site': 'same-origin',
    });

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOfTarget()).toEqual([]);
  });

  test('a request with neither header proceeds', async () => {
    const response = await resetTarget({});

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOfTarget()).toEqual([]);
  });

  test('a safe method from another origin is not refused', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/dash/users', {
        headers: baseHeaders({
          cookie: seeded().admin.cookie,
          origin: SIBLING_ORIGIN,
          'sec-fetch-site': 'same-site',
        }),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});

describe('the CORS preflight', () => {
  test('advertises only the headers a browser caller sends', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/health/storage', {
        method: 'OPTIONS',
        headers: baseHeaders({
          origin: PUBLIC_ORIGIN,
          'access-control-request-method': 'GET',
          'access-control-request-headers':
            'x-maintenance-token, authorization',
        }),
      })
    );

    const allowed = (response.headers.get('access-control-allow-headers') ?? '')
      .toLowerCase()
      .split(',')
      .map((name) => name.trim());
    expect(allowed).toContain('x-captcha-response');
    expect(allowed).not.toContain('x-maintenance-token');
    expect(allowed).not.toContain('authorization');
  });
});

describe('/api/auth/* keeps Better Auth as its only origin check', () => {
  test('an untrusted Origin is refused with the library-shaped body', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/sign-out', {
        method: 'POST',
        headers: baseHeaders({
          cookie: seeded().admin.cookie,
          origin: SIBLING_ORIGIN,
          'sec-fetch-site': 'same-site',
        }),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await response.json()).toEqual({
      message: MSG_UNTRUSTED_ORIGIN,
      code: CUSTOM_AUTH_CODE,
    });
  });

  test('a trusted Origin over same-site fetch metadata is left to the library, which admits it', async () => {
    const user = await seedUser();
    const response = await app.handle(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: baseHeaders({
          'content-type': 'application/json',
          origin: PUBLIC_ORIGIN,
          'sec-fetch-site': 'same-site',
          'sec-fetch-mode': 'cors',
        }),
        body: JSON.stringify({ email: user.email, password: user.password }),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});
