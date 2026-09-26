import type { MockSession, MockUser } from '../store';

import { generateUUIDv7 } from '@/utils';
import { http, HttpResponse } from 'msw';
import { ROLE_SCOPE } from '@/lib/permissions/constants';

import { now } from '../lib/db';
import { api, fail, MSG, ok, readBody } from '../lib/http';
import { roles, session, users } from '../store';

const SESSION_DAYS = 7;

function startSession(user: MockUser): MockSession {
  const createdAt = now();
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 86_400_000
  ).toISOString();

  const next: MockSession = {
    session: {
      id: generateUUIDv7(),
      token: generateUUIDv7(),
      userId: user.id,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    },
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified ?? false,
      image: null,
      createdAt: user.createdAt ?? createdAt,
      updatedAt: user.updatedAt ?? createdAt,
    },
  };
  session.set(next);
  return next;
}

function createAdmin(name: string, email: string, password: string) {
  const systemRole = roles.all().find((r) => r.scope === ROLE_SCOPE.SYSTEM);
  const createdAt = now();
  return users.insert({
    id: generateUUIDv7(),
    name,
    email,
    password,
    emailVerified: true,
    isActive: true,
    roleId: systemRole?.id ?? null,
    role: systemRole
      ? {
          id: systemRole.id,
          roleName: systemRole.roleName,
          scope: systemRole.scope,
        }
      : null,
    createdAt,
    updatedAt: createdAt,
  });
}

export const authHandlers = [
  http.get(api('/api/auth/get-session'), () => {
    const current = session.get();
    // A user deleted from the dashboard loses the session.
    if (!current || !users.find(current.user.id)) {
      session.set(null);
      return HttpResponse.json(null);
    }
    return HttpResponse.json(current);
  }),

  // Any email and password signs in: a known email as that user, an unknown
  // one as a new full-access user. `mockApi.fail` covers the refusal paths.
  http.post(api('/api/auth/sign-in/email'), async ({ request }) => {
    const { email = '', password = '' } = await readBody<{
      email: string;
      password: string;
    }>(request);
    const user =
      users.all().find((u) => u.email.toLowerCase() === email.toLowerCase()) ??
      createAdmin(email.split('@', 1)[0] || email, email, password);

    const { session: created, user: sessionUser } = startSession(user);
    return HttpResponse.json({
      redirect: false,
      token: created.token,
      user: sessionUser,
    });
  }),

  http.post(api('/api/auth/sign-out'), () => {
    session.set(null);
    return HttpResponse.json({ success: true });
  }),

  http.post(api('/api/dev/sign-up'), async ({ request }) => {
    const { name, email, password } = await readBody<MockUser>(request);
    if (!name || !email || !password) {
      return fail(422, MSG.invalidInput);
    }
    if (users.all().some((u) => u.email === email)) {
      return fail(409, MSG.emailExists);
    }

    const user = createAdmin(name, email, password);
    return ok({ id: user.id }, 'تم إنشاء الحساب بنجاح');
  }),
];
