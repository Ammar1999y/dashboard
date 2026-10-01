/**
 * A database read of the caller's grants rewrites a stale permission snapshot
 * in the session row AND the cookie cache.
 *
 * The stale state is the one a sign-in racing a role edit leaves: the role's
 * rows change, no session refresh reaches this session. It is produced here by
 * editing `role_permissions` directly, which skips `refreshRoleSessions` the
 * same way.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import { rolePermissions, sessions } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/api-messages';

import { auth } from '@/lib/auth';
import { refreshRoleSessions } from '@/lib/permissions/session-refresh';

import { resetTables } from '../helpers/database';
import { authedRequest, mergeCookies, signedInUser } from '../helpers/session';

const GRANTS = { users: { view: true, create: true } } as const;

const context = await auth.$context;
const CACHE = context.authCookies.sessionData.name;
const TOKEN = context.authCookies.sessionToken.name;

function listUsers(session: SignedInSession): Promise<Response> {
  return app.handle(authedRequest(session, '/api/dash/users?perPage=5'));
}

function createUser(session: SignedInSession): Promise<Response> {
  return app.handle(
    authedRequest(session, '/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  );
}

function withoutSessionCache(session: SignedInSession): SignedInSession {
  const cookie = session.cookie
    .split('; ')
    .filter((pair) => !pair.startsWith(`${CACHE}=`))
    .join('; ');
  expect(cookie).not.toBe(session.cookie);
  return { ...session, cookie };
}

function applyResponse(
  session: SignedInSession,
  response: Response
): SignedInSession {
  return {
    ...session,
    cookie: mergeCookies(session.cookie, response.headers.getSetCookie()),
  };
}

function setCookieNames(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split('=', 1)[0] ?? '');
}

async function revokeView(session: SignedInSession): Promise<void> {
  await db
    .update(rolePermissions)
    .set({ permissions: { view: false, create: true } })
    .where(eq(rolePermissions.roleId, session.user.roleId));
}

async function rowGrantsView(session: SignedInSession): Promise<unknown> {
  const [row] = await db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.userId, session.user.userId));
  return row?.metadata?.permissions?.users?.view;
}

beforeEach(async () => {
  await resetTables();
}, 30_000);

describe('a stale snapshot', () => {
  test('a write rewrites the row and re-mints the cache', async () => {
    const session = await signedInUser({ permissions: GRANTS });
    await revokeView(session);

    // The documented cache window: the stale cookie still answers a read.
    const cached = await listUsers(session);
    expect(cached.status).toBe(HTTP_STATUS.OK);

    const write = await createUser(session);
    // 422: `create` survived, so the write was authorised and reached validation.
    expect(write.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(setCookieNames(write)).toContain(CACHE);
    expect(await rowGrantsView(session)).toBe(false);

    const read = await listUsers(applyResponse(session, write));
    expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
  }, 30_000);

  test('a read without the cache rewrites the row and re-mints the cache', async () => {
    const session = await signedInUser({ permissions: GRANTS });
    await revokeView(session);

    const uncached = await listUsers(withoutSessionCache(session));
    expect(uncached.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await rowGrantsView(session)).toBe(false);

    const read = await listUsers(applyResponse(session, uncached));
    expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
  }, 30_000);

  test('a cookie stale behind a refreshed row is re-minted, the row left alone', async () => {
    const session = await signedInUser({ permissions: GRANTS });
    await revokeView(session);
    // What a role edit does: the rows follow, the issued cookies do not.
    await withTransaction((tx) => refreshRoleSessions(session.user.roleId, tx));
    const [before] = await db
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.userId, session.user.userId));

    const write = await createUser(session);
    expect(write.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(setCookieNames(write)).toContain(CACHE);

    const [after] = await db
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.userId, session.user.userId));
    expect(after?.updatedAt).toEqual(before?.updatedAt);

    const read = await listUsers(applyResponse(session, write));
    expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
  }, 30_000);

  test('an up-to-date snapshot is left alone', async () => {
    const session = await signedInUser({ permissions: GRANTS });
    const [before] = await db
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.userId, session.user.userId));

    const write = await createUser(session);
    expect(write.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(setCookieNames(write)).not.toContain(CACHE);

    const [after] = await db
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.userId, session.user.userId));
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  }, 30_000);
});

describe('a revoked session', () => {
  test('a write answers 401 and clears the session cookies', async () => {
    const session = await signedInUser({ permissions: GRANTS });
    await db.delete(sessions).where(eq(sessions.userId, session.user.userId));

    const write = await createUser(session);
    expect(write.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const cleared = mergeCookies(session.cookie, write.headers.getSetCookie());
    expect(cleared).not.toContain(`${TOKEN}=`);
    expect(cleared).not.toContain(`${CACHE}=`);
  }, 30_000);
});
