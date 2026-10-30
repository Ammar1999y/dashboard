import { beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';

import { asc, eq, inArray, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { sessions, users, verifications } from '@/db/schema';

import { HTTP_STATUS } from '@app/shared/http-status';

import { MAX_SESSIONS_PER_USER } from '@/lib/auth/session/cap';
import { reauthMethodKey } from '@/lib/auth/verifications';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import {
  baseHeaders,
  seedUser,
  signedInUser,
  signIn,
} from '../helpers/session';

const READ_URL = 'http://localhost/api/dash/roles';

interface Fixture {
  userId: string;
  tokenOnly: string;
}

async function fixture(): Promise<Fixture> {
  const session = await signedInUser();
  const token = session.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('better-auth.session_token='));
  if (!token) throw new Error('sign-in set no session token');
  return { userId: session.user.userId, tokenOnly: token };
}

function read(cookie: string): Promise<Response> {
  const headers = new Headers(baseHeaders());
  headers.set('cookie', cookie);
  return app.handle(new Request(READ_URL, { headers }));
}

beforeEach(async () => {
  await resetTables();
});

describe('a read with the cookie cache missed', () => {
  test('succeeds while the account is active', async () => {
    const { tokenOnly } = await fixture();
    const response = await read(tokenOnly);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  test('is refused once the account is deactivated, session row intact', async () => {
    const { userId, tokenOnly } = await fixture();

    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));

    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);

    const response = await read(tokenOnly);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('is refused once the account is soft-deleted, session row intact', async () => {
    const { userId, tokenOnly } = await fixture();

    await db
      .update(users)
      .set({ deletedAt: new Date(), isActive: false })
      .where(eq(users.id, userId));

    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);

    const response = await read(tokenOnly);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});

describe('a read with a valid cookie cache', () => {
  test('accepts the configured five-minute revocation window', async () => {
    const session = await signedInUser();
    await db.delete(sessions).where(eq(sessions.userId, session.user.userId));

    const response = await read(session.cookie);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});

describe('signing out takes the session artifacts with it', () => {
  /**
   * `revokeSessionArtifacts` says every path that deletes a session owes it the
   * call. The three `verifications` rows keyed by the SESSION id — the
   * two-factor proof and both re-authentication windows — store no user id, so
   * a session deleted without them leaves rows nothing can find again until
   * they expire. `/sign-out` deletes the row in the `before` hook
   * (`lib/auth/path-policy.ts`) through `revokeSessionsWhere`; the
   * `session.delete.after` database hook covers the library's own deletes.
   */
  test('the re-authentication window opened on it is gone', async () => {
    // `signedInUser` opens the window, which is what writes the rows: a fixture
    // that only signed in would make this vacuous.
    const session = await signedInUser();
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, session.user.userId));
    const sessionId = row?.id;
    expect(sessionId).toBeString();

    const identifiers = [
      `2fa-proven-${sessionId}`,
      `reauth-method-${sessionId}`,
      `reauth-passkey-${sessionId}`,
    ];
    const artifacts = () =>
      db
        .select({ identifier: verifications.identifier })
        .from(verifications)
        .where(inArray(verifications.identifier, identifiers));

    expect(await artifacts()).not.toBeEmpty();

    const response = await app.handle(
      new Request('http://localhost/api/auth/sign-out', {
        method: 'POST',
        headers: baseHeaders({
          'content-type': 'application/json',
          cookie: session.cookie,
          // Better Auth's router-level origin check refuses a cookie-carrying
          // non-GET without one (403), before the endpoint runs at all.
          origin: PUBLIC_ORIGIN,
        }),
        body: '{}',
      })
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    expect(
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId as string))
    ).toBeEmpty();
    expect(await artifacts()).toBeEmpty();
  });
});

describe('the per-user session cap', () => {
  // The cap's worth of rows for `userId`; offsets from now, in seconds, by row.
  async function seedAtCap(
    userId: string,
    expires: (g: SQL) => SQL,
    created: (g: SQL) => SQL
  ): Promise<void> {
    const g = sql.raw('g');
    await db.execute(sql`
      insert into sessions (id, token, user_id, expires_at, created_at)
      select gen_random_uuid(), 'cap-' || g || '-' || ${userId}, ${userId}::uuid,
             now() + (${expires(g)} || ' seconds')::interval,
             now() + (${created(g)} || ' seconds')::interval
        from generate_series(1, ${MAX_SESSIONS_PER_USER}) as g`);
  }

  const heldBy = (userId: string) =>
    db
      .select({
        id: sessions.id,
        token: sessions.token,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId));

  const tokenOf = (cookie: string) =>
    cookie.match(/session_token=([^.;]+)/)?.[1];

  test('a sign-in past the cap evicts the oldest rows, never the new one', async () => {
    // Unbounded, one account's rows grew every revocation's work without limit,
    // and past 21,845 broke it outright.
    const user = await seedUser();
    await seedAtCap(
      user.userId,
      () => sql`86400`,
      (g) => sql`-60 * ${g}`
    );
    const [oldest] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, user.userId))
      .orderBy(asc(sessions.createdAt))
      .limit(1);
    if (!oldest) throw new Error('no seeded session');
    await db.insert(verifications).values({
      identifier: reauthMethodKey(oldest.id),
      value: user.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const signedIn = await signIn(user);

    const held = await heldBy(user.userId);
    expect(held).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(held.map((row) => row.id)).not.toContain(oldest.id);
    const newToken = tokenOf(signedIn.cookie);
    expect(newToken).toBeString();
    expect(held.some((row) => row.token === newToken)).toBe(true);
    // The evicted row went the way every revocation goes: with its artifacts.
    expect(
      await db
        .select({ id: verifications.id })
        .from(verifications)
        .where(eq(verifications.identifier, reauthMethodKey(oldest.id)))
    ).toBeEmpty();
  });

  test('keeps the new session even when every stored row outranks it', async () => {
    // Stamped ahead of it, as after the clock stepped back.
    const user = await seedUser();
    await seedAtCap(
      user.userId,
      () => sql`86400`,
      (g) => sql`3600 - ${g}`
    );

    const signedIn = await signIn(user);

    const held = await heldBy(user.userId);
    expect(held).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(held.some((row) => row.token === tokenOf(signedIn.cookie))).toBe(
      true
    );
  });

  test('evicts expired rows before older live ones', async () => {
    const user = await seedUser();
    // Half expired yet newer than the live half.
    await seedAtCap(
      user.userId,
      (g) => sql`case when ${g} <= 50 then -60 else 86400 end`,
      (g) => sql`-${g}`
    );

    await signIn(user);

    const now = Date.now();
    const held = await heldBy(user.userId);
    const live = held.filter((row) => row.expiresAt.getTime() > now);
    // The 50 live seeded rows and the new one.
    expect(live).toHaveLength(MAX_SESSIONS_PER_USER / 2 + 1);
  });
});
