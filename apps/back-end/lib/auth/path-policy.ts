import type { HookContext } from './context';
import type { AcceptedPasswordHashes } from './login-guard';
import type { EntityID } from '@app/shared/types';
import type { TwoFactorMethod } from '@app/shared/validation/enums';
import type { APIError } from 'better-auth/api';

import { eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { sessions } from '@/db/schema';
import { formCsrfMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INVALID_CREDENTIALS } from '@app/shared/messages/auth';
import {
  MSG_INVALID_INPUT,
  MSG_PAGE_NOT_FOUND,
} from '@app/shared/messages/common';
import { validID } from '@app/shared/utils';
import { loginSchema } from '@app/shared/validation/auth';
import { NAME_MAX, PASSWORD_MAX } from '@app/shared/validation/constants';
import { normalizePasswordInput } from '@app/shared/validation/rules';

import {
  parseSetCookieHeaders,
  queueResponseCookies,
} from '@/lib/http/cookies';

import { exceedsCodePoints } from '@/utils/text';

import { BETTER_AUTH_ALLOWED_PATH_SET } from './allowed-paths';
import { authAuditMeta, bodyRecord } from './context';
import { credentialAccountOf } from './credential-account';
import { authError, reauthenticationRequired, sessionRequired } from './errors';
import { LoginRejected, verifyLoginAttempt } from './login-guard';
import { mintPasswordProof } from './password/proof';
import { consumeReauthGrant } from './reauth/grant';
import { verifyReauthPassword } from './reauth/password';
import { hasAdminReauth } from './reauth/window';
import { assertLiveSession } from './session/live';
import { submittedRememberMe } from './session/remember-me';
import { resolveRequestSession } from './session/request';
import { revokeSessionsWhere } from './session/rotation';
import {
  PLUGIN_VERIFIER_METHOD,
  requireTwoFactorChallenge,
} from './two-factor/challenge';

/**
 * Cookieless paths: the router-level origin check is skipped and the endpoint's
 * `formCsrfMiddleware` runs AFTER this hook, so it is run here first.
 */
const FIRST_LOGIN_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/passwordless/verify',
  '/oauth/google/start',
]);

/**
 * Library paths that reach `password.verify`. ⚠️ One missing here mints no
 * proof and rejects every password; update it whenever the allow-list grows.
 */
export const PASSWORD_PROOF_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/get-totp-uri',
]);

// The library's session middlewares answer from the cookie cache and ignore
// `is_active` / `deleted_at`, so a suspended user would otherwise keep access.
const LIVE_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/reauth/methods',
  '/reauth/passkey/options',
  '/reauth/passkey/verify',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/two-factor/totp/start',
  '/two-factor/totp/confirm',
  '/two-factor/trust-device',
  '/two-factor/trusted-devices',
  '/two-factor/trusted-devices/revoke',
  '/two-factor/methods',
  '/two-factor/methods/disable',
  '/two-factor/methods/default',
  '/two-factor/backup-codes/acknowledge',
  '/two-factor/passkey/grant',
  // A suspended user could otherwise register a credential that survives every
  // later revocation.
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);

// Enrolment and sign-in on one path: liveness only when a session is present,
// since the sign-in branch holds just a challenge cookie.
const DUAL_MODE_LIVE_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

// Their library bodies cannot carry a password; they spend a
// `/two-factor/passkey/grant` grant instead.
const REAUTH_GRANT_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
]);

const PASSKEY_BOUNDED_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);

const PASSKEY_ID_PATHS: ReadonlySet<string> = new Set([
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);

const TRUST_DEVICE_STRIPPED_PATHS: ReadonlySet<string> = new Set(
  Object.keys(PLUGIN_VERIFIER_METHOD)
);

/**
 * A session minted here completes no second factor, and `recordPasskeyEnrolment`
 * would delete it after its cookie was set, leaving a cached token for a
 * missing row.
 */
const SESSION_CREATION_STRIPPED_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
]);

// Better Call's path for an endpoint declared without one. Upstream drift fails
// closed: our `auth.api.*` server-only calls answer 404.
const SERVER_ONLY_VIRTUAL_PATH = '/';

/**
 * By `auth.api` key. ⚠️ Never a blanket pass on `'/'`: every server-only
 * endpoint reports it, including `viewBackupCodes`, which returns any user's
 * decrypted recovery codes.
 */
const SERVER_ONLY_OPERATIONS: ReadonlySet<string> = new Set(['generateTOTP']);

export async function enforcePathPolicy(
  ctx: HookContext
): Promise<{ context: unknown } | undefined> {
  const internalSchemaGeneration =
    ctx.path === '/open-api/generate-schema' && !ctx.request;
  // All three conditions are required: `!ctx.request` alone would exempt every
  // `auth.api.*` call, the placeholder alone a request for `/api/auth/`.
  const serverOnlyEndpoint =
    ctx.path === SERVER_ONLY_VIRTUAL_PATH &&
    !ctx.request &&
    SERVER_ONLY_OPERATIONS.has(
      String(('operationId' in ctx ? ctx.operationId : undefined) ?? '')
    );
  if (
    !internalSchemaGeneration &&
    !serverOnlyEndpoint &&
    !BETTER_AUTH_ALLOWED_PATH_SET.has(ctx.path)
  )
    throw authError(HTTP_STATUS.NOT_FOUND, MSG_PAGE_NOT_FOUND);

  if (FIRST_LOGIN_PATHS.has(ctx.path)) await formCsrfMiddleware(ctx);

  rejectOverlongPassword(ctx);

  const twoFactorContext = await enforceTwoFactorPathPolicy(ctx);
  queueSessionReadCookies(ctx);
  if (twoFactorContext) return twoFactorContext;

  if (ctx.path === '/sign-in/email') return await signInContext(ctx);
  if (ctx.path === '/sign-out') await revokeSignedOutSession(ctx);
}

/**
 * ⚠️ Better Auth replaces a before hook's response headers with the endpoint's
 * once the endpoint runs, and the session read here memoises, so the
 * endpoint's own read sets nothing. The read's cookies (the sliding refresh, a
 * re-minted cache) go to the response's exit queue instead, where a cookie the
 * endpoint sets itself wins its name.
 */
function queueSessionReadCookies(ctx: HookContext): void {
  const cookies = ctx.responseHeaders?.getSetCookie() ?? [];
  if (ctx.request && cookies.length > 0)
    queueResponseCookies(ctx.request.headers, parseSetCookieHeaders(cookies));
}

// Ahead of the library, whose delete swallows a fault and answers 200 with the
// cookies cleared. A fault here is `app.ts`'s 500 with the cookies kept, so the
// client can retry.
async function revokeSignedOutSession(ctx: HookContext): Promise<void> {
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret
  );
  if (!token) return;
  await withTransaction((tx) =>
    revokeSessionsWhere(tx, eq(sessions.token, token))
  );
}

/**
 * ⚠️ The returned body is MERGED with the caller's (`defuReplaceArrays`), so an
 * omitted key survives. `callbackURL` is kept from being an open redirect by the
 * library's `originCheckMiddleware`, not by this return.
 */
async function signInContext(ctx: HookContext): Promise<{ context: unknown }> {
  const { email, password, rememberMe } = bodyRecord(ctx);

  const { success, data } = loginSchema.safeParse({
    email,
    password,
    rememberMe,
    // Already verified by the captcha plugin's `onRequest`, ahead of every hook.
    captcha: 'success',
  });

  if (!success) throw authError(HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_INPUT);

  const auditMeta = authAuditMeta(ctx);

  let acceptedHashes: AcceptedPasswordHashes;
  try {
    acceptedHashes = await verifyLoginAttempt({
      email: data.email,
      password: data.password,
      auditMeta,
      purpose: 'sign_in',
    });
  } catch (e) {
    if (e instanceof LoginRejected)
      throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
    throw e;
  }

  return withBody(ctx, {
    email: data.email,
    password: mintPasswordProof(acceptedHashes),
    // Explicit, not left to the merge: it must survive into the challenge record.
    rememberMe: submittedRememberMe({ rememberMe: data.rememberMe }),
  });
}

async function enforceTwoFactorPathPolicy(
  ctx: HookContext
): Promise<{ context: unknown } | undefined> {
  const path = ctx.path ?? '';
  assertPasskeyInputBounds(ctx, path);
  const needsProof = PASSWORD_PROOF_PATHS.has(path);
  const needsLiveSession = LIVE_SESSION_PATHS.has(path);
  const stripsTrustDevice = TRUST_DEVICE_STRIPPED_PATHS.has(path);
  const stripsSessionCreation = SESSION_CREATION_STRIPPED_PATHS.has(path);
  const dualMode = DUAL_MODE_LIVE_SESSION_PATHS.has(path);
  const needsGrant = REAUTH_GRANT_PATHS.has(path);

  const pluginMethod = PLUGIN_VERIFIER_METHOD[path];
  if (pluginMethod) await assertPluginVerifierOffered(ctx, pluginMethod);

  if (dualMode || needsGrant) {
    const mode = await resolveRequestSession(ctx);
    if (mode) {
      await requireLiveSession(ctx, mode.sessionId, mode.userId);
      if (
        needsGrant &&
        !(await consumeReauthGrant(ctx, {
          userId: mode.userId,
          purpose: 'two_factor_enrolment',
          token: grantToken(ctx, path),
        }))
      )
        throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
    } else if (needsGrant) throw sessionRefused(ctx);
  }

  if (
    !needsProof &&
    !needsLiveSession &&
    !stripsTrustDevice &&
    !stripsSessionCreation
  )
    return undefined;

  const body = bodyRecord(ctx);

  // Overwritten, not deleted: the body is merged. `disableSession` on a sign-in
  // verification spends a backup code without completing the challenge.
  const patch: Record<string, unknown> = {
    ...(stripsTrustDevice && { trustDevice: false, disableSession: false }),
    ...(stripsSessionCreation && { createSession: false }),
  };

  if (!needsProof && !needsLiveSession)
    return withBody(ctx, { ...body, ...patch });

  // Memoised for the endpoint's session middleware, which reads a fault as no
  // session; liveness is checked against the row below, not the cookie cache.
  const session = await resolveRequestSession(ctx);
  if (!session) throw sessionRefused(ctx);

  // A grant path checked it above.
  if (needsLiveSession && !needsGrant)
    await requireLiveSession(ctx, session.sessionId, session.userId);

  if (!needsProof) return withBody(ctx, { ...body, ...patch });

  const supplied = body.password;
  if (
    supplied === undefined &&
    (await hasAdminReauth(session.sessionId, session.userId))
  ) {
    const credential = await db.query.accounts.findFirst({
      where: credentialAccountOf(session.userId),
    });
    if (credential?.password)
      return withBody(ctx, {
        ...body,
        ...patch,
        password: mintPasswordProof([credential.password]),
      });
  }
  if (supplied === undefined) throw reauthenticationRequired();

  const acceptedHashes = await verifyReauthPassword(
    session.userId,
    supplied,
    authAuditMeta(ctx)
  );
  if (!acceptedHashes)
    throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);

  return withBody(ctx, {
    ...body,
    ...patch,
    password: mintPasswordProof(acceptedHashes),
  });
}

function withBody(
  ctx: HookContext,
  body: Record<string, unknown>
): { context: unknown } {
  return { context: { ...ctx, body } };
}

async function requireLiveSession(
  ctx: HookContext,
  sessionId: string,
  userId: EntityID
): Promise<void> {
  try {
    await assertLiveSession(sessionId, userId);
  } catch (error) {
    if (
      error instanceof CustomError &&
      error.status === HTTP_STATUS.UNAUTHORIZED
    )
      throw sessionRefused(ctx);
    throw error;
  }
}

/**
 * ⚠️ A before hook's throw is answered with the error's own headers alone, so
 * what the session read set, and the expiries of a session the request
 * presented, ride on it. `getSessionFromCtx` answers a 401 it caught as no
 * session, its expiries dropped.
 */
function sessionRefused(ctx: HookContext): APIError {
  if (ctx.getCookie(ctx.context.authCookies.sessionToken.name) !== null)
    deleteSessionCookie(ctx);
  const cookies = lastPerName(ctx.responseHeaders?.getSetCookie() ?? []);
  const headers = new Headers(ctx.responseHeaders);
  headers.delete('set-cookie');
  for (const entry of cookies) headers.append('set-cookie', entry);
  return sessionRequired(headers);
}

// `deleteSessionCookie` expires an unchunked cache twice: once by name, once
// as a stale chunk.
function lastPerName(setCookies: readonly string[]): string[] {
  const byName = new Map<string, string>();
  for (const entry of setCookies) {
    const name = entry.split('=', 1)[0] ?? '';
    byName.delete(name);
    byName.set(name, entry);
  }
  return byName.values().toArray();
}

/**
 * The plugin's verifiers consult no offered set, so they could complete a
 * sign-in with a method the challenge never offered. Duplicated in
 * `two-factor/plugin.ts` on purpose.
 */
async function assertPluginVerifierOffered(
  ctx: HookContext,
  method: TwoFactorMethod
): Promise<void> {
  await requireTwoFactorChallenge(ctx, { method, signInOnly: true });
}

/**
 * The library's schemas leave `name` unbounded and `id` a plain string, which
 * would 500 against the columns. `app.ts` mounts one wildcard, so this hook is
 * the only per-path boundary.
 */
function assertPasskeyInputBounds(ctx: HookContext, path: string): void {
  if (!PASSKEY_BOUNDED_PATHS.has(path)) return;
  const body = bodyRecord(ctx);

  const name = body.name;
  // `varchar` counts characters; the plugin's schema trims before the column.
  const overlongName =
    typeof name === 'string' && exceedsCodePoints(name.trim(), NAME_MAX);
  const id = body.id;
  const malformedId =
    PASSKEY_ID_PATHS.has(path) && (typeof id !== 'string' || !validID(id));

  if (overlongName || malformedId)
    throw authError(HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_INPUT);
}

// The body wins. Registration also reads `?grant=`: the stock client's
// `addPasskey` writes that body itself, over any `grant` a caller puts in it.
function grantToken(ctx: HookContext, path: string): unknown {
  const fromBody = bodyRecord(ctx).grant;
  if (fromBody !== undefined || path !== '/passkey/verify-registration')
    return fromBody;
  const query: unknown = ctx.query;
  return query && typeof query === 'object' && 'grant' in query
    ? query.grant
    : undefined;
}

// Must use `passwordSchema`'s unit (normalised code points), or it refuses logins
// with passwords the rotation routes accepted.
function rejectOverlongPassword(ctx: HookContext): void {
  const supplied = bodyRecord(ctx).password;
  if (
    typeof supplied !== 'string' ||
    !exceedsCodePoints(normalizePasswordInput(supplied), PASSWORD_MAX)
  )
    return;
  throw authError(HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_INPUT);
}
