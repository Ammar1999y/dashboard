import type { MockSession, MockUser } from '../store';

import { http, HttpResponse } from 'msw';
import { BETTER_AUTH_BODIES, REQUEST_BODIES } from '@app/shared/contract';
import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_CREDENTIALS } from '@app/shared/messages/auth';
import { MSG_EMAIL_EXISTS } from '@app/shared/messages/users';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';

import { generateEntityId } from '@/utils/generate-id';

import { now } from '../lib/db';
import { api, created, fail, readJsonBody } from '../lib/http';
import { mayHoldSession } from '../lib/permissions';
import { currentUser, roleRef, roles, session, users } from '../store';

const emailOwner = (email: string) =>
  users.all().find((u) => u.email.toLowerCase() === email.toLowerCase());

const SESSION_DAYS = 7;

function startSession(user: MockUser): MockSession {
  const createdAt = now();
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 86_400_000
  ).toISOString();

  const next: MockSession = {
    session: {
      id: generateEntityId(),
      token: generateEntityId(),
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
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
  session.set(next);
  return next;
}

function createAdmin(name: string, email: string, password: string) {
  const systemRole = roles.all().find((r) => r.scope === ROLE_SCOPE.SYSTEM);
  const createdAt = now();
  return users.insert({
    id: generateEntityId(),
    name,
    email,
    password,
    emailVerified: true,
    isActive: true,
    roleId: systemRole?.id ?? null,
    role: systemRole ? roleRef(systemRole) : null,
    createdBy: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export const authHandlers = [
  // The server revokes a user's sessions when the account, or its role, is
  // deactivated or deleted; here that is the one session ending.
  http.get(api('/api/auth/get-session'), () => {
    const current = session.get();
    const user = currentUser();
    if (!current || !user || !mayHoldSession(user)) {
      session.set(null);
      return HttpResponse.json(null);
    }
    return HttpResponse.json(current);
  }),

  // Any password signs in: a known email as that user, refused as the server
  // refuses it, and an unknown one as a new full-access user.
  http.post(api('/api/auth/sign-in/email'), async ({ request }) => {
    const { email, password } = await readJsonBody(
      request,
      BETTER_AUTH_BODIES['/sign-in/email']
    );
    const known = emailOwner(email);
    // Better Auth's error body, not the API envelope.
    if (known && !mayHoldSession(known))
      return HttpResponse.json(
        { code: CUSTOM_AUTH_CODE, message: MSG_INVALID_CREDENTIALS },
        { status: HTTP_STATUS.UNAUTHORIZED }
      );
    const user =
      known ?? createAdmin(email.split('@', 1)[0] || email, email, password);

    const { session: started, user: sessionUser } = startSession(user);
    return HttpResponse.json({
      redirect: false,
      token: started.token,
      user: sessionUser,
    });
  }),

  http.post(api('/api/auth/sign-out'), () => {
    session.set(null);
    return HttpResponse.json({ success: true });
  }),

  http.post(api('/api/dev/sign-up'), async ({ request }) => {
    const body = await readJsonBody(
      request,
      REQUEST_BODIES['POST /api/dev/sign-up']
    );
    if (emailOwner(body.email))
      return fail(HTTP_STATUS.CONFLICT, MSG_EMAIL_EXISTS);

    const user = createAdmin(body.name, body.email, body.password);
    return created(user.id);
  }),
];
