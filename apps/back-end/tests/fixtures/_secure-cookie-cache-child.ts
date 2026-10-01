import { installEgressGuard } from '../helpers/egress';

installEgressGuard();
const { and, eq } = await import('drizzle-orm');
const { db, closeDatabase } = await import('@/db');
const { rolePermissions, users } = await import('@/db/schema');
const { CustomError } = await import('@app/shared/error-class');
const { auth } = await import('@/lib/auth');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { checkUserPermission } = await import('@/lib/permissions/checker');
const { authedRequest, seedUser, signIn } = await import('../helpers/session');
const { app } = await import('@/app');

if (!PUBLIC_ORIGIN.startsWith('https://'))
  throw new Error(`Expected an https origin, got ${PUBLIC_ORIGIN}.`);

const context = await auth.$context;
const cacheCookie = context.createAuthCookie('session_data').name;
if (!cacheCookie.startsWith('__Secure-'))
  throw new Error(`Expected a __Secure- cookie name, got ${cacheCookie}.`);

type Session = Awaited<ReturnType<typeof signIn>>;

async function freshSession(): Promise<Session> {
  return signIn(
    await seedUser({ permissions: { users: { view: true, create: true } } })
  );
}

/** The jar as signed in, the cache cookie as a `.0` chunk, and without it. */
function cookieVariants(session: Session): Record<string, string> {
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

async function observe(session: Session): Promise<Record<string, number>> {
  const statuses: Record<string, number> = {};
  const variants = Object.entries(cookieVariants(session));
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

const control = await freshSession();
const narrowed = await freshSession();
const deactivated = await freshSession();

// AFTER sign-in, so each session's cookie cache still carries the old state.
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

const observed = {
  control: await observe(control),
  narrowed: await observe(narrowed),
  deactivated: await observe(deactivated),
};

await closeDatabase();

// Cached reads keep the grant until `cookieCache.maxAge` (the accepted window);
// everything else sees the change at once.
const expected = {
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
};

if (JSON.stringify(observed) !== JSON.stringify(expected))
  throw new Error(`Unexpected statuses: ${JSON.stringify(observed)}.`);

console.log('Secure cookie cache honoured on reads only.');
