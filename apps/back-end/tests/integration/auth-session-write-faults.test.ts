/**
 * The `sessions` INSERT every sign-in method ends in, when its input is at the
 * column bound and when the database refuses it.
 *
 * - A `User-Agent` longer than `sessions.user_agent` signs in: the header is cut
 *   to the column width instead of failing the INSERT for that client forever.
 * - A database fault on a Better Auth route reaches `handleApiError`, so the log
 *   line keeps the diagnosis (error classes, SQL text, SQLSTATE, constraint)
 *   while the bound parameters — the new session token, the user id, the IP —
 *   never reach it. Better Call's own handler printed the raw error instead.
 * - A fault Better Auth catches and answers 500 for itself is logged once,
 *   through the same redaction.
 * - `/sign-out` whose session row cannot be deleted answers 500 instead of the
 *   library's 200, which swallowed the fault and cleared the cookies of a
 *   session that stayed live.
 */
import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { sessions } from '@/db/schema';

import { HTTP_STATUS, MSG_INTERNAL_ERROR } from '@app/shared/api-messages';

import { USER_AGENT_MAX } from '@/lib/audit/constants';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import { baseHeaders, seedUser, signIn, TEST_IP } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

function signInWith(
  user: SeededUser,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json', ...headers }),
      body: JSON.stringify({ email: user.email, password: user.password }),
    })
  );
}

async function storedUserAgents(userId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ userAgent: sessions.userAgent })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.map((row) => row.userAgent);
}

beforeAll(async () => {
  await resetTables();
});

beforeEach(() => {
  // The per-IP sign-in budget is per process and shared across files.
  resetSqliteStores();
});

describe('a User-Agent at and past the sessions.user_agent bound', () => {
  test.each([USER_AGENT_MAX, USER_AGENT_MAX + 1, 600])(
    'a %i-character User-Agent signs in and is stored cut to the column',
    async (length) => {
      const user = await seedUser();
      const userAgent = `Harness/${'u'.repeat(length - 'Harness/'.length)}`;

      const response = await signInWith(user, { 'user-agent': userAgent });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers.getSetCookie()).not.toEqual([]);
      expect(await storedUserAgents(user.userId)).toEqual([
        userAgent.slice(0, USER_AGENT_MAX),
      ]);
    }
  );
});

describe('a database fault on a Better Auth route', () => {
  test('answers the standard 500 and logs the diagnosis without the bound parameters', async () => {
    const user = await seedUser();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    await db.execute(
      sql`alter table sessions add constraint harness_session_fault check (false) not valid`
    );
    try {
      const response = await signInWith(user);

      expect(response.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
      expect(await response.json()).toEqual({
        success: false,
        message: MSG_INTERNAL_ERROR,
        data: null,
      });

      expect(logged).toHaveBeenCalledTimes(1);
      const line = JSON.stringify(logged.mock.calls);
      for (const diagnosis of [
        'DrizzleQueryError',
        'PostgresError',
        'insert into',
        '23514',
        'harness_session_fault',
      ])
        expect(line).toContain(diagnosis);
      for (const parameter of ['params:', user.userId, TEST_IP])
        expect(line).not.toContain(parameter);
      expect(line).not.toContain('# SERVER_ERROR');
      expect(await storedUserAgents(user.userId)).toEqual([]);
    } finally {
      await db.execute(
        sql`alter table sessions drop constraint harness_session_fault`
      );
      logged.mockRestore();
    }
  });

  // The dash route drops the cookie cache so `auth.api.getSession` reads the row.
  test.each([
    ['the get-session route', '/api/auth/get-session?disableCookieCache=true'],
    ["a dash route's server-side session read", '/api/dash/users'],
  ])('on %s logs one sanitised line and nothing raw', async (_, path) => {
    const { user, cookie: signedIn } = await signIn(await seedUser());
    const cookie = signedIn
      .split('; ')
      .filter((pair) => !pair.includes('session_data'))
      .join('; ');
    const sessionToken = /session_token=([^.;]+)/.exec(cookie)?.[1];
    if (!sessionToken) throw new Error('sign-in set no session token cookie');
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    await db.execute(sql`alter table users rename column name to harness_name`);
    try {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          headers: baseHeaders({ cookie }),
        })
      );

      expect(response.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
      expect(logged).toHaveBeenCalledTimes(1);
      const printed = logged.mock.calls
        .flat()
        .map((value) => Bun.inspect(value))
        .join('\n');
      for (const diagnosis of ['betterAuth', 'DrizzleQueryError', '42703'])
        expect(printed).toContain(diagnosis);
      for (const parameter of ['params:', user.userId, sessionToken])
        expect(printed).not.toContain(parameter);
    } finally {
      await db.execute(
        sql`alter table users rename column harness_name to name`
      );
      logged.mockRestore();
    }
  });
});

describe('a session delete fault on /sign-out', () => {
  function signOut(cookie: string): Promise<Response> {
    return app.handle(
      new Request('http://localhost/api/auth/sign-out', {
        method: 'POST',
        headers: baseHeaders({
          'content-type': 'application/json',
          cookie,
          origin: PUBLIC_ORIGIN,
        }),
        body: '{}',
      })
    );
  }

  async function sessionIds(userId: string): Promise<string[]> {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    return rows.map((row) => row.id);
  }

  function clearedCookies(response: Response): string[] {
    return response.headers
      .getSetCookie()
      .filter((value) => /max-age=0/i.test(value))
      .map((value) => value.split('=', 1)[0] ?? '');
  }

  test('answers the standard 500, keeps the cookies and logs one sanitised line', async () => {
    const { user, cookie } = await signIn(await seedUser());
    const sessionToken = /session_token=([^.;]+)/.exec(cookie)?.[1];
    if (!sessionToken) throw new Error('sign-in set no session token cookie');
    const before = await sessionIds(user.userId);
    expect(before).toHaveLength(1);

    const logged = spyOn(console, 'error').mockImplementation(() => {});
    await db.execute(sql`
      create function harness_refuse_session_delete() returns trigger
      language plpgsql as $$ begin raise exception 'harness session delete fault'; end $$
    `);
    await db.execute(sql`
      create trigger harness_session_delete_fault before delete on sessions
      for each row execute function harness_refuse_session_delete()
    `);
    try {
      const response = await signOut(cookie);

      expect(response.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
      expect(await response.json()).toEqual({
        success: false,
        message: MSG_INTERNAL_ERROR,
        data: null,
      });
      // Cleared, the browser could not retry the revocation it was told failed.
      expect(clearedCookies(response)).toEqual([]);
      expect(await sessionIds(user.userId)).toEqual(before);

      expect(logged).toHaveBeenCalledTimes(1);
      const printed = logged.mock.calls
        .flat()
        .map((value) => Bun.inspect(value))
        .join('\n');
      expect(printed).toContain('harness session delete fault');
      for (const parameter of ['params:', user.userId, sessionToken])
        expect(printed).not.toContain(parameter);
    } finally {
      await db.execute(
        sql`drop trigger harness_session_delete_fault on sessions`
      );
      await db.execute(sql`drop function harness_refuse_session_delete()`);
      logged.mockRestore();
    }

    const retried = await signOut(cookie);
    expect(retried.status).toBe(HTTP_STATUS.OK);
    expect(await sessionIds(user.userId)).toEqual([]);
  });

  test('without a fault, signs out as before', async () => {
    const { user, cookie } = await signIn(await seedUser());

    const response = await signOut(cookie);

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await response.json()).toMatchObject({ success: true });
    expect(clearedCookies(response)).toEqual(
      expect.arrayContaining(['better-auth.session_token'])
    );
    expect(await sessionIds(user.userId)).toEqual([]);
  });
});
