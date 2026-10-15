import { http, HttpResponse } from 'msw';
import { BETTER_AUTH_BODIES, REQUEST_BODIES } from '@app/shared/contract';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_LOGIN_REQUIRED,
  MSG_REAUTH_GRANTED,
} from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT } from '@app/shared/messages/common';
import { MSG_EMAIL_EXISTS } from '@app/shared/messages/users';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';
import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { generateEntityId } from '@/utils/generate-id';

import { requireUnspentCaptcha } from '../lib/captcha';
import { now } from '../lib/db';
import {
  api,
  asPlugin,
  created,
  fail,
  ok,
  parseOrThrow,
  pluginOk,
  readJson,
  readJsonBody,
} from '../lib/http';
import { mayHoldSession, sessionMetadata } from '../lib/permissions';
import {
  openReauthWindow,
  REAUTH_WINDOW_S,
  reauthMethodsOf,
} from '../lib/reauth';
import {
  admitSession,
  issueChallenge,
  startSession,
  twoFactorUnavailable,
} from '../lib/sign-in';
import {
  issueProof,
  requireServed,
  requireSessionUser,
  takeProof,
  twoFactorOf,
} from '../lib/two-factor';
import { randomToken } from '../lib/two-factor-model';
import { currentUser, roleRef, roles, session, users } from '../store';

const emailOwner = (email: string) =>
  users.all().find((u) => u.email.toLowerCase() === email.toLowerCase());

/** How long the options of a passkey proof stay valid, the server's `CEREMONY_MAX_AGE_S`. */
const REAUTH_CEREMONY_TTL_S = 300;

const sessionIdOf = () => session.get()?.session.id ?? '';

const reauthDenied = () =>
  new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);

/** Better Auth's error body, not the API envelope. */
const authError = (status: number, message: string) =>
  HttpResponse.json({ code: CUSTOM_AUTH_CODE, message }, { status });

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
    return HttpResponse.json({
      ...current,
      session: { ...current.session, metadata: sessionMetadata(user) },
    });
  }),

  // Any password signs in: a known email as that user, refused as the server
  // refuses it, and an unknown one as a new full-access user. The first factor
  // is judged in the server's order: the credentials, the account's admission,
  // then whether a second factor stands between it and a session.
  asPlugin(
    http.post(api('/api/auth/sign-in/email'), async ({ request }) => {
      requireUnspentCaptcha(request);
      const { email, password, rememberMe } = await readJsonBody(
        request,
        BETTER_AUTH_BODIES['/sign-in/email']
      );
      const known = emailOwner(email);
      if (known) admitSession(known);
      const user =
        known ?? createAdmin(email.split('@', 1)[0] || email, email, password);

      const outcome = issueChallenge(user, {
        firstFactor: 'password',
        rememberMe: rememberMe ?? true,
      });
      if (outcome.kind === 'refused') throw twoFactorUnavailable();
      if (outcome.kind === 'challenge') return HttpResponse.json(outcome.body);

      const { session: started, user: sessionUser } = startSession(user);
      return HttpResponse.json({
        redirect: false,
        token: started.token,
        user: sessionUser,
      });
    })
  ),

  http.post(api('/api/auth/sign-out'), () => {
    session.set(null);
    return HttpResponse.json({ success: true });
  }),

  // The project's plugins answer `{ success, data }` with no `message`, and a
  // refusal in Better Auth's error body: neither is the API envelope.
  http.get(api('/api/auth/reauth/methods'), () => {
    const user = currentUser();
    if (!user || !session.get() || !mayHoldSession(user))
      return authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
    return HttpResponse.json({
      success: true,
      data: { methods: reauthMethodsOf(user.id) },
    });
  }),

  // The ceremony runs in the browser against these options; nothing here can
  // check what an authenticator signed, so an assertion for a credential the
  // account holds is accepted, as at the second factor.
  asPlugin(
    http.post(api('/api/auth/reauth/passkey/options'), () => {
      requireServed(isTwoFactorMethodEnabled('passkey'));
      const user = requireSessionUser();
      const { passkeys } = twoFactorOf(user.id);
      if (passkeys.length === 0) throw reauthDenied();

      const challenge = randomToken(32);
      issueProof(user.id, 'reauth-passkey', sessionIdOf(), {
        value: challenge,
        ttlSeconds: REAUTH_CEREMONY_TTL_S,
      });
      return pluginOk({
        challenge,
        rpId: globalThis.location?.hostname ?? 'localhost',
        allowCredentials: passkeys.map(({ credentialId }) => ({
          id: credentialId,
          type: 'public-key',
        })),
        userVerification: 'required',
        timeout: 60_000,
      });
    })
  ),

  asPlugin(
    http.post(api('/api/auth/reauth/passkey/verify'), async ({ request }) => {
      requireServed(isTwoFactorMethodEnabled('passkey'));
      const user = requireSessionUser();
      const { response } = parseOrThrow(
        BETTER_AUTH_BODIES['/reauth/passkey/verify'],
        await readJson(request),
        MSG_INVALID_INPUT
      );
      // A ceremony that was never started, or already spent, is denied.
      if (!takeProof(user.id, 'reauth-passkey', sessionIdOf()))
        throw reauthDenied();
      const known = twoFactorOf(user.id).passkeys.some(
        ({ credentialId }) => credentialId === response.id
      );
      if (!known) throw reauthDenied();
      openReauthWindow('passkey');
      return pluginOk({ expiresIn: REAUTH_WINDOW_S });
    })
  ),

  // Any password that passes the schema opens the window, as any signs in. The
  // server's refusals follow: a body the schema rejects is the same 401 as a
  // wrong password, and a wrong password also counts toward the lockout, which
  // this mock does not model (`mockApi.fail` stands in for it).
  http.post(api('/api/dash/auth/reauth'), async ({ request }) => {
    if (!currentUser())
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
    const body = REQUEST_BODIES['POST /api/dash/auth/reauth'].safeParse(
      await readJson(request)
    );
    if (!body.success)
      throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
    openReauthWindow('password');
    return ok({ expiresIn: REAUTH_WINDOW_S }, MSG_REAUTH_GRANTED);
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
