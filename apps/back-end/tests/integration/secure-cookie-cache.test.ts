/**
 * Under an https origin the cookie cache is `__Secure-` prefixed. A read honours
 * it, plain or chunked, until `cookieCache.maxAge` (the accepted window); a
 * write or a `forceDB` check sees a narrowed role or a deactivation at once.
 *
 * Runs only in the `https-origin` row of `tests/helpers/run.ts`.
 */
import { beforeEach, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { rolePermissions, users } from '@/db/schema';

import { CustomError } from '@app/shared/error-class';

import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { checkUserPermission } from '@/lib/permissions/checker';

import { resetTables } from '../helpers/database';
import { resetRateLimits } from '../helpers/rate-limit';
import { authedRequest, seedUser, signIn } from '../helpers/session';

beforeEach(resetTables);
beforeEach(resetRateLimits);

type Session = Awaited<ReturnType<typeof signIn>>;

async function freshSession(): Promise<Session> {
  return signIn(
    await seedUser({ permissions: { users: { view: true, create: true } } })
  );
}

/** The jar as signed in, the cache cookie as a `.0` chunk, and without it. */
function cookieVariants(
  session: Session,
  cacheCookie: string
): Record<string, string> {
  const pairs = session.cookie.split('; ');
  const cachePair = pairs.find((pair) => pair.startsWith(`${cacheCookie}=`));
  if (!cachePair) throw new Error(`Sign-in set no ${cacheCookie}.`);
  const withoutCache = pairs.filter((pair) => pair !== cachePair);
  return {
    cached: session.cookie,
    chunked: [
      ...withoutCache,
      `${cacheCookie}.0=${cachePair.slice(cacheCookie.length + 1)}`,
    ].join('; '),
    uncached: withoutCache.join('; '),
  };
}

async function statusOf(check: Promise<unknown>): Promise<number> {
  try {
    await check;
    return 200;
  } catch (error) {
    if (error instanceof CustomError && error.status) return error.status;
    throw error;
  }
}

async function observe(
  session: Session,
  cacheCookie: string
): Promise<Record<string, number>> {
  const statuses: Record<string, number> = {};
  const variants = Object.entries(cookieVariants(session, cacheCookie));
  for (const [variant, cookie] of variants) {
    const response = await app.handle(
      authedRequest({ ...session, cookie }, '/api/dash/users?perPage=5')
    );
    statuses[`${variant} read`] = response.status;
  }

  const headers = authedRequest(session, '/').headers;
  statuses['forceDB read'] = await statusOf(
    checkUserPermission({
      headers,
      resource: 'users',
      action: 'view',
      forceDB: true,
    })
  );
  statuses['write'] = await statusOf(
    checkUserPermission({ headers, resource: 'users', action: 'create' })
  );
  return statuses;
}

test('a read honours the secure cookie cache, plain or chunked, and a write or forceDB check does not', async () => {
  expect(PUBLIC_ORIGIN.startsWith('https://')).toBe(true);
  const context = await auth.$context;
  const cacheCookie = context.createAuthCookie('session_data').name;
  expect(cacheCookie.startsWith('__Secure-')).toBe(true);

  const control = await freshSession();
  const narrowed = await freshSession();
  const deactivated = await freshSession();

  // After sign-in, so each session's cookie cache still carries the old state.
  await db
    .update(rolePermissions)
    .set({ permissions: { view: false, create: false } })
    .where(
      and(
        eq(rolePermissions.roleId, narrowed.user.roleId),
        eq(rolePermissions.pageName, 'users')
      )
    );
  await db
    .update(users)
    .set({ isActive: false })
    .where(eq(users.id, deactivated.user.userId));

  expect({
    control: await observe(control, cacheCookie),
    narrowed: await observe(narrowed, cacheCookie),
    deactivated: await observe(deactivated, cacheCookie),
  }).toEqual({
    control: {
      'cached read': 200,
      'chunked read': 200,
      'uncached read': 200,
      'forceDB read': 200,
      write: 200,
    },
    narrowed: {
      'cached read': 200,
      'chunked read': 200,
      'uncached read': 403,
      'forceDB read': 403,
      write: 403,
    },
    deactivated: {
      'cached read': 200,
      'chunked read': 200,
      'uncached read': 401,
      'forceDB read': 401,
      write: 401,
    },
  });
}, 30_000);
