/**
 * The cookies a session read sets reach the client from table routes too, and
 * a "do not remember" session gets the same five-minute read cache.
 *
 * "Served from the cache" is proved by deleting the session row first: the
 * database path answers 401 for it, the cache 200. Time moves with
 * `setSystemTime`, which Better Auth's cache expiry reads; PostgreSQL's `now()`
 * does not move, and minutes cannot cross a row's expiry either way.
 */
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import type { SignedInSession } from '../helpers/session';
import type { HandlerCookie } from '@/lib/http/contract';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { sessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';

import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { parseSetCookieHeaders } from '@/lib/http/cookies';

import { resetTables } from '../helpers/database';
import {
  authedRequest,
  mergeCookies,
  seedUser,
  signIn,
} from '../helpers/session';

const GRANTS = { users: { view: true, create: true } } as const;
const READ_URL = '/api/dash/users?perPage=5';
const DAY_MS = 24 * 60 * 60 * 1000;

const context = await auth.$context;
const CACHE = context.authCookies.sessionData.name;
const TOKEN = context.authCookies.sessionToken.name;
const MARKER = context.authCookies.dontRememberToken.name;
const CACHE_MAX_AGE_S = context.authCookies.sessionData.attributes.maxAge ?? 0;
const EXPIRES_IN_S = context.sessionConfig.expiresIn;
const UPDATE_AGE_S = context.sessionConfig.updateAge;

function cookiesOf(response: Response): HandlerCookie[] {
  return parseSetCookieHeaders(response.headers.getSetCookie());
}

function named(response: Response, name: string): HandlerCookie[] {
  return cookiesOf(response).filter((cookie) => cookie.name === name);
}

function withoutCookie(
  session: SignedInSession,
  name: string
): SignedInSession {
  const cookie = session.cookie
    .split('; ')
    .filter((pair) => !pair.startsWith(`${name}=`))
    .join('; ');
  expect(cookie).not.toBe(session.cookie);
  return { ...session, cookie };
}

function read(session: SignedInSession): Promise<Response> {
  return app.handle(authedRequest(session, READ_URL));
}

/** The browser's jar after `response`. */
function after(session: SignedInSession, response: Response): SignedInSession {
  return {
    ...session,
    cookie: mergeCookies(session.cookie, response.headers.getSetCookie()),
  };
}

/** The compact strategy's payload expiry, in milliseconds. */
function payloadExpiry(cookie: HandlerCookie): number {
  const decoded: unknown = JSON.parse(
    Buffer.from(cookie.value, 'base64url').toString('utf8')
  );
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('expiresAt' in decoded) ||
    typeof decoded.expiresAt !== 'number'
  )
    throw new Error('session_data carries no expiresAt');
  return decoded.expiresAt;
}

/** A cache minted, just before `now`, to live the configured `cookieCache.maxAge`. */
function expectFullCache(cookie: HandlerCookie | undefined, now: number): void {
  expect(cookie?.value).toBeTruthy();
  expect(cookie?.options?.maxAge).toBe(CACHE_MAX_AGE_S);
  if (!cookie) return;
  const lifetime = payloadExpiry(cookie) - now;
  expect(lifetime).toBeGreaterThan((CACHE_MAX_AGE_S - 5) * 1000);
  expect(lifetime).toBeLessThanOrEqual(CACHE_MAX_AGE_S * 1000);
}

function expectExpired(response: Response, name: string): void {
  const [cookie] = named(response, name);
  expect(cookie?.value).toBe('');
  expect(cookie?.options?.maxAge).toBe(0);
}

async function deleteSessionRows(session: SignedInSession): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, session.user.userId));
}

async function sessionExpiry(session: SignedInSession): Promise<number> {
  const [row] = await db
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.userId, session.user.userId));
  if (!row) throw new Error('no session row');
  return row.expiresAt.getTime();
}

/** Puts the row past `updateAge`, so the next database read slides it. */
async function ageSessionPastUpdateAge(
  session: SignedInSession
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + (EXPIRES_IN_S - UPDATE_AGE_S) * 1000 - 60_000
  );
  await db
    .update(sessions)
    .set({ expiresAt })
    .where(eq(sessions.userId, session.user.userId));
}

async function remembered(): Promise<SignedInSession> {
  return signIn(await seedUser({ permissions: GRANTS }));
}

async function notRemembered(): Promise<SignedInSession> {
  return signIn(await seedUser({ permissions: GRANTS }), {
    rememberMe: false,
  });
}

beforeAll(async () => {
  await resetTables();
  expect(CACHE_MAX_AGE_S).toBeGreaterThan(60);
});

afterEach(() => {
  setSystemTime();
});

describe('a dashboard read delivers the cookies its session read sets', () => {
  test('a read without the cache re-mints it, and the next read is served from it', async () => {
    const session = withoutCookie(await remembered(), CACHE);

    const first = await read(session);
    expect(first.status).toBe(HTTP_STATUS.OK);
    const minted = named(first, CACHE);
    expect(minted).toHaveLength(1);
    expectFullCache(minted[0], Date.now());

    await deleteSessionRows(session);
    const second = await read(after(session, first));
    expect(second.status).toBe(HTTP_STATUS.OK);
    expect(named(second, CACHE)).toEqual([]);
  });

  test('a 401 after the cache expired and the row went carries the expiry', async () => {
    const session = await remembered();
    await deleteSessionRows(session);
    setSystemTime(new Date(Date.now() + (CACHE_MAX_AGE_S + 1) * 1000));

    const response = await read(session);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expectExpired(response, CACHE);
    expectExpired(response, TOKEN);
  });

  test('a read past `updateAge` delivers the slid session token', async () => {
    const session = withoutCookie(await remembered(), CACHE);
    await ageSessionPastUpdateAge(session);
    const before = await sessionExpiry(session);

    const response = await read(session);
    expect(response.status).toBe(HTTP_STATUS.OK);
    const [token] = named(response, TOKEN);
    expect(token?.value).toBeTruthy();
    expect(token?.options?.maxAge).toBe(EXPIRES_IN_S);
    expect(await sessionExpiry(session)).toBeGreaterThan(before + DAY_MS / 2);
  });

  test('the upload route reads the session twice and emits each cookie once', async () => {
    const session = withoutCookie(await remembered(), CACHE);
    await ageSessionPastUpdateAge(session);

    const response = await app.handle(
      authedRequest(session, '/api/upload/file?resource=users', {
        method: 'POST',
      })
    );
    expect(response.status).not.toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(response.status).not.toBe(HTTP_STATUS.FORBIDDEN);

    const names = cookiesOf(response).map((cookie) => cookie.name);
    expect(names).toContain(CACHE);
    expect(names).toContain(TOKEN);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * The before hook reads the session for these and the endpoint reuses that
 * read, so its cookies are the only ones the response can carry. The POST is
 * handed to Better Auth as a rebuilt request, and its answer is a refusal.
 */
describe('a Better Auth route whose hook reads the session delivers its cookies', () => {
  test.each([
    ['GET', '/api/auth/two-factor/methods', undefined, HTTP_STATUS.OK],
    ['GET', '/api/auth/reauth/methods', undefined, HTTP_STATUS.OK],
    [
      'POST',
      '/api/auth/two-factor/methods/default',
      { method: 'totp' },
      HTTP_STATUS.NOT_FOUND,
    ],
  ] as const)('%s %s', async (method, path, body, status) => {
    const session = withoutCookie(await remembered(), CACHE);
    await ageSessionPastUpdateAge(session);
    const before = await sessionExpiry(session);

    const response = await app.handle(
      authedRequest(session, path, {
        method,
        ...(body && {
          body: JSON.stringify(body),
          headers: {
            'content-type': 'application/json',
            origin: PUBLIC_ORIGIN,
          },
        }),
      })
    );
    expect(response.status).toBe(status);
    expect(await sessionExpiry(session)).toBeGreaterThan(before + DAY_MS / 2);
    const [token] = named(response, TOKEN);
    expect(token?.value).toBeTruthy();
    expect(token?.options?.maxAge).toBe(EXPIRES_IN_S);
    expect(named(response, CACHE)).toHaveLength(1);
    const names = cookiesOf(response).map((cookie) => cookie.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('a "do not remember" session', () => {
  test('signs in with a full cache and a browser-session token', async () => {
    const session = await notRemembered();
    const cookies = parseSetCookieHeaders(session.setCookie);

    const caches = cookies.filter((cookie) => cookie.name === CACHE);
    expect(caches).toHaveLength(1);
    expectFullCache(caches[0], Date.now());
    const token = cookies.find((cookie) => cookie.name === TOKEN);
    expect(token?.value).toBeTruthy();
    expect(token?.options?.maxAge).toBeUndefined();
    expect(
      cookies.find((cookie) => cookie.name === MARKER)?.value
    ).toBeTruthy();
  });

  test('a read after the cache expired re-mints it for the full window, served from then on', async () => {
    const session = await notRemembered();

    const later = Date.now() + (CACHE_MAX_AGE_S + 1) * 1000;
    setSystemTime(new Date(later));
    const first = await read(session);
    expect(first.status).toBe(HTTP_STATUS.OK);
    const minted = named(first, CACHE);
    expect(minted).toHaveLength(1);
    expectFullCache(minted[0], later);

    // Past what the library's own 60 s payload would have lived.
    await deleteSessionRows(session);
    setSystemTime(new Date(later + 120_000));
    const second = await read(after(session, first));
    expect(second.status).toBe(HTTP_STATUS.OK);
    expect(named(second, CACHE)).toEqual([]);
    expect(named(first, TOKEN)).toEqual([]);
  });

  test("Better Auth's own route re-mints it the same way", async () => {
    const session = withoutCookie(await notRemembered(), CACHE);

    const response = await app.handle(
      authedRequest(session, '/api/auth/get-session')
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    const minted = named(response, CACHE);
    expect(minted).toHaveLength(1);
    expectFullCache(minted[0], Date.now());
  });

  test('is still not slid past `updateAge`', async () => {
    const session = withoutCookie(await notRemembered(), CACHE);
    await ageSessionPastUpdateAge(session);
    const before = await sessionExpiry(session);

    const response = await read(session);
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(named(response, TOKEN)).toEqual([]);
    expect(await sessionExpiry(session)).toBe(before);
  });

  test('an expired row is cleared, and no cache is minted for it', async () => {
    const session = withoutCookie(await notRemembered(), CACHE);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.userId, session.user.userId));

    const response = await app.handle(
      authedRequest(session, '/api/auth/get-session')
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await response.json()).toBeNull();
    expectExpired(response, TOKEN);
    // Only the expiry: a re-mint would be appended after it.
    expect(named(response, CACHE)).toHaveLength(1);
    expectExpired(response, CACHE);
  });

  test('the cache cookie alone, as after a browser restart, authenticates nothing', async () => {
    const session = await notRemembered();
    const cacheOnly = withoutCookie(withoutCookie(session, TOKEN), MARKER);

    const dash = await read(cacheOnly);
    expect(dash.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const own = await app.handle(
      authedRequest(cacheOnly, '/api/auth/get-session')
    );
    expect(own.status).toBe(HTTP_STATUS.OK);
    expect(await own.json()).toBeNull();
  });
});
