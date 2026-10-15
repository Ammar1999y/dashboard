/**
 * Every mutating route, judged from the bindings rather than from a list.
 *
 * Each binding's contract entry declares its `auth` policy, and the gate's
 * permission check runs FIRST on every permission-gated route — before its
 * limiter, before its body is read. Two actors drive every non-public mutating
 * route: nobody at all, and a signed-in user whose role grants nothing (with the
 * re-authentication window open, so the re-auth gate cannot stand in for the
 * permission decision). A route added to the bindings is in this walk the moment it
 * exists; a route that declares itself public and mutates has to be named in
 * `PUBLIC_MUTATING` on purpose.
 *
 * The body flag is asserted too: `readJson`/`readFormData` consume the request,
 * so `bodyUsed` after a refusal says whether the refusal was an admission
 * decision or a late one. A binding whose target is always the caller
 * (`PUT /api/dash/users/me`) has no one else to be refused for, so it sits out
 * the permission walk.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';
import { BINDINGS } from '@/modules';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_LOGIN_REQUIRED } from '@app/shared/messages/auth';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';

import { generateUuidV7 } from '@/lib/id';

import { compareCodeUnits } from '@/utils/text';

import { resetTables } from '../helpers/database';
import { expectError } from '../helpers/expect-body';
import { authedRequest, baseHeaders, signedInUser } from '../helpers/session';

/**
 * Session routes whose handler refuses a grant only the request can name
 * (a contextual check the gate leaves to the handler). The policy cannot say so, so each is named here and walked as
 * permission-gated; the walk below catches a session route that refuses for a
 * grant without being named.
 */
const CONTEXTUAL_GRANT: ReadonlySet<string> = new Set([
  'POST /api/upload/file',
]);

// `BINDINGS` includes what this process does not register (the
// development-only sign-up outside development), so every public route stays a
// named decision.
const TABLE = BINDINGS.map(({ key, entry }) => ({
  method: entry.method,
  path: entry.path,
  body: entry.bodyKind,
  auth: CONTEXTUAL_GRANT.has(key) ? 'permission' : entry.policy.auth,
  policyAuth: entry.policy.auth,
}));
const MUTATING = TABLE.filter((route) => route.method !== 'GET');

const SELF_ONLY: ReadonlySet<string> = new Set(
  BINDINGS.filter(({ options }) => options.permission?.orSelf === true).map(
    ({ key }) => key
  )
);

/**
 * The mutating routes that answer with no session at all. Each one carries its
 * own admission (captcha, per-IP limiter, OTP proof) and every one of them is a
 * deliberate decision — so the list is explicit, and a new public mutating route
 * fails this file until it is added here on purpose.
 */
const PUBLIC_MUTATING = [
  'POST /api/auth/forgot-password/reset',
  'POST /api/auth/forgot-password/second-factor/send',
  'POST /api/auth/forgot-password/complete',
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/otp/send',
  'POST /api/auth/otp/verify',
  'POST /api/auth/passwordless/send',
  'POST /api/dev/sign-up',
];

const GUARDED = MUTATING.filter((route) => route.auth !== 'public');
const PERMISSION_GATED = GUARDED.filter(
  (route) => route.auth === 'permission' && !SELF_ONLY.has(label(route))
);
const SESSION_GATED = GUARDED.filter((route) => route.auth === 'session');

function label(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

/**
 * Query strings a route needs before its permission check can even be named.
 * The upload route checks the grant on the page `?resource=` points at, so the
 * page has to be supplied for the refusal to be a permission decision rather
 * than a 400 on the missing parameter.
 */
const QUERY_FOR: Readonly<Record<string, string>> = {
  'POST /api/upload/file': '?resource=users',
};

/** A concrete URL: every `:id` becomes a well-formed id that names nothing. */
function targetUrl(route: { method: string; path: string }): string {
  const path = route.path.replaceAll(/:[a-zA-Z]+/g, () => generateUuidV7());
  return `${path}${QUERY_FOR[label(route)] ?? ''}`;
}

function bodyFor(route: (typeof TABLE)[number]): {
  body?: BodyInit;
  headers: Record<string, string>;
} {
  if (route.body === 'json')
    return { body: '{}', headers: { 'content-type': 'application/json' } };
  if (route.body === 'multipart') {
    const form = new FormData();
    form.append('probe', '1');
    return { body: form, headers: {} };
  }
  return { headers: {} };
}

const state: { nobody: SignedInSession | null } = { nobody: null };

beforeAll(async () => {
  await resetTables();
  // A role with NO grants, and the re-authentication window OPEN: the only gate
  // left to refuse is the permission decision.
  state.nobody = await signedInUser({ permissions: {} });
}, 30_000);

describe('the route table', () => {
  test('every public mutating route is a named decision', () => {
    const publicMutating = MUTATING.filter(
      (route) => route.auth === 'public'
    ).map(label);
    expect(publicMutating.toSorted(compareCodeUnits)).toEqual(
      PUBLIC_MUTATING.toSorted(compareCodeUnits)
    );
  });

  test('the walks below are not empty', () => {
    expect(GUARDED.length).toBeGreaterThan(5);
    expect(PERMISSION_GATED.length).toBeGreaterThan(3);
    expect(SESSION_GATED.length).toBeGreaterThan(3);
  });

  test('every route named for a contextual grant is a mutating session route', () => {
    expect(
      [...CONTEXTUAL_GRANT].filter(
        (key) =>
          !MUTATING.some(
            (route) => label(route) === key && route.policyAuth === 'session'
          )
      )
    ).toEqual([]);
  });
});

describe.each(GUARDED.map((route) => [label(route), route] as const))(
  '%s',
  (_name, route) => {
    test('with no session is refused 401 before the body is read', async () => {
      const { body, headers } = bodyFor(route);
      const request = new Request(`http://localhost${targetUrl(route)}`, {
        method: route.method,
        headers: baseHeaders(headers),
        body,
      });

      await expectError(
        await app.handle(request),
        HTTP_STATUS.UNAUTHORIZED,
        MSG_LOGIN_REQUIRED
      );
      expect(request.bodyUsed).toBe(false);
    });
  }
);

describe.each(PERMISSION_GATED.map((route) => [label(route), route] as const))(
  '%s',
  (_name, route) => {
    test('with a session that holds no grant is refused 403', async () => {
      if (!state.nobody) throw new Error('fixture not seeded');
      const { body, headers } = bodyFor(route);
      const request = authedRequest(state.nobody, targetUrl(route), {
        method: route.method,
        headers,
        body,
      });

      await expectError(
        await app.handle(request),
        HTTP_STATUS.FORBIDDEN,
        MSG_INSUFFICIENT_PERMISSIONS
      );
      expect(request.bodyUsed).toBe(false);
    });
  }
);

describe.each(SESSION_GATED.map((route) => [label(route), route] as const))(
  '%s',
  (_name, route) => {
    test('is not refused for a grant: a route that is belongs in CONTEXTUAL_GRANT', async () => {
      if (!state.nobody) throw new Error('fixture not seeded');
      const { body, headers } = bodyFor(route);
      const response = await app.handle(
        authedRequest(state.nobody, targetUrl(route), {
          method: route.method,
          headers,
          body,
        })
      );
      const answer: unknown = await response.json();
      expect(answer).not.toMatchObject({
        message: MSG_INSUFFICIENT_PERMISSIONS,
      });
    });
  }
);
