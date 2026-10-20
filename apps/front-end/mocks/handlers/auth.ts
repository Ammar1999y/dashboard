import { http, HttpResponse } from 'msw';
import { reauthenticate } from '@app/shared/api/auth';
import * as contract from '@app/shared/api/better-auth';
import { devSignUp } from '@app/shared/api/dev';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INVALID_CREDENTIALS,
  MSG_LOGIN_REQUIRED,
  MSG_REAUTH_GRANTED,
} from '@app/shared/messages/auth';
import { MSG_CREATED, MSG_INVALID_INPUT } from '@app/shared/messages/common';
import { MSG_EMAIL_EXISTS } from '@app/shared/messages/users';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';
import { loginSchema } from '@app/shared/validation/auth';
import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { generateEntityId } from '@/utils/generate-id';

import { requireUnspentCaptcha } from '../lib/captcha';
import { now } from '../lib/db';
import { mock } from '../lib/endpoint';
import { api, parseOrThrow, readJson, readJsonBody } from '../lib/http';
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

function createAdmin(name: string, email: string, password: string) {
  const systemRole = roles.all().find((r) => r.scope === ROLE_SCOPE.SYSTEM);
  const createdAt = now();
  return users.insert({
    id: generateEntityId(),
    name,
    email,
    password,
    emailVerified: true,
    phoneNumber: null,
    phoneNumberVerified: false,
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
  http.post(api('/api/auth/sign-in/email'), async ({ request }) => {
    requireUnspentCaptcha(request);
    const { email, password, rememberMe } = await readJsonBody(
      request,
      loginSchema.omit({ captcha: true })
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
  }),

  http.post(api('/api/auth/sign-out'), () => {
    session.set(null);
    return HttpResponse.json({ success: true });
  }),

  mock(contract.reauthMethods, () => {
    const user = currentUser();
    if (!user || !session.get() || !mayHoldSession(user))
      throw new CustomError(
        MSG_INVALID_CREDENTIALS,
        HTTP_STATUS.UNAUTHORIZED,
        CUSTOM_AUTH_CODE
      );
    return { raw: { data: { methods: reauthMethodsOf(user.id) } } };
  }),

  // The ceremony runs in the browser against these options; nothing here can
  // check what an authenticator signed, so an assertion for a credential the
  // account holds is accepted, as at the second factor.
  mock(contract.reauthPasskeyOptions, () => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const user = requireSessionUser();
    const { passkeys } = twoFactorOf(user.id);
    if (passkeys.length === 0) throw reauthDenied();

    const challenge = randomToken(32);
    issueProof(user.id, 'reauth-passkey', sessionIdOf(), {
      value: challenge,
      ttlSeconds: REAUTH_CEREMONY_TTL_S,
    });
    return {
      raw: {
        data: {
          challenge,
          rpId: globalThis.location?.hostname ?? 'localhost',
          allowCredentials: passkeys.map(({ credentialId }) => ({
            id: credentialId,
            type: 'public-key' as const,
          })),
          userVerification: 'required' as const,
          timeout: 60_000,
        },
      },
    };
  }),

  mock(contract.reauthPasskeyVerify, async ({ request }) => {
    requireServed(isTwoFactorMethodEnabled('passkey'));
    const user = requireSessionUser();
    const { response } = parseOrThrow(
      contract.reauthPasskeyVerify.body,
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
    return { raw: { data: { expiresIn: REAUTH_WINDOW_S } } };
  }),

  // Any password that passes the schema opens the window, as any signs in. The
  // server's refusals follow: a body the schema rejects is the same 401 as a
  // wrong password, and a wrong password also counts toward the lockout, which
  // this mock does not model (`mockApi.fail` stands in for it).
  mock(reauthenticate, async ({ request }) => {
    if (!currentUser())
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
    // A malformed body is answered like a wrong password.
    const body = reauthenticate.body.safeParse(await readJson(request));
    if (!body.success)
      throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
    openReauthWindow('password');
    return {
      message: MSG_REAUTH_GRANTED,
      data: { expiresIn: REAUTH_WINDOW_S },
    };
  }),

  mock(devSignUp, async ({ body: read }) => {
    const body = await read();
    if (emailOwner(body.email))
      throw new CustomError(MSG_EMAIL_EXISTS, HTTP_STATUS.CONFLICT);

    const user = createAdmin(body.name, body.email, body.password);
    return { message: MSG_CREATED, data: { id: user.id } };
  }),
];
