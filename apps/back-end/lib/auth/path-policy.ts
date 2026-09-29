/**
 * Better Auth's `before` hook: the path allow-list and every per-path rule this
 * deployment applies before the library's own handler runs.
 */
import type { HookContext } from './context';
import type { AcceptedPasswordHashes } from './login-guard';
import type { EntityID } from '@app/shared/types';
import type { TwoFactorMethod } from '@app/shared/validation/enums';

import { db } from '@/db';
import { formCsrfMiddleware } from 'better-auth/api';

import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
  MSG_PAGE_NOT_FOUND,
} from '@app/shared/api-messages';
import { validID } from '@app/shared/utils';
import { loginSchema } from '@app/shared/validation/auth';
import { NAME_MAX, PASSWORD_MAX } from '@app/shared/validation/constants';
import { normalizePasswordInput } from '@app/shared/validation/rules';

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
import {
  PLUGIN_VERIFIER_METHOD,
  requireTwoFactorChallenge,
} from './two-factor/challenge';

/**
 * The paths a browser reaches with no cookie at all, where Better Auth's
 * router-level origin check is skipped and its `formCsrfMiddleware` runs on the
 * endpoint itself — AFTER this hook. Anything the hook does for these paths
 * before that check runs against an unvalidated origin, so the check is run
 * here first. Every other listed path needs a session or a challenge cookie,
 * which the router-level check already validates.
 */
const FIRST_LOGIN_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/passwordless/verify',
  '/oauth/google/start',
]);

/**
 * Better Auth paths that verify a password through `validatePassword` /
 * `checkPassword`, and therefore reach `password.verify`.
 *
 * ⚠️ A password-taking path that is NOT here mints no proof and so rejects every
 * password. Update this whenever the allow-list grows. The 2FA endpoints this
 * deployment owns (`two-factor/enrolment.ts`) never reach `password.verify`;
 * they call `requireReauthPassword`.
 */
const PASSWORD_PROOF_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/get-totp-uri',
]);

/**
 * Session-bearing Better Auth paths that must pass this application's liveness
 * predicate before the plugin's own middleware sees them.
 *
 * `sessionMiddleware` and `freshSessionMiddleware` resolve a session through the
 * cookie CACHE and consult neither `users.is_active` nor `users.deleted_at`, so
 * a suspended or soft-deleted user whose row still exists otherwise keeps full
 * access here — the class `session/live.ts` exists to close.
 */
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

/**
 * Paths that serve BOTH an enrolment and a sign-in verification.
 *
 * Not in `LIVE_SESSION_PATHS`, which would demand a session on the sign-in
 * branch, where the caller holds only a challenge cookie. Liveness is required
 * on the session branch alone — and required, because these are writes that
 * `sessionMiddleware` would otherwise admit for a suspended account.
 */
const DUAL_MODE_LIVE_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

/**
 * WebAuthn paths that add or remove a factor, and cannot carry a password of
 * their own — the ceremony spans two requests with the library's bodies. They
 * spend a grant minted by `/two-factor/passkey/grant` instead.
 */
const REAUTH_GRANT_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
]);

/** Plugin paths carrying a `name` this schema bounds at `NAME_MAX`. */
const PASSKEY_BOUNDED_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);

/** …and the subset whose `id` must be a UUID this schema could actually hold. */
const PASSKEY_ID_PATHS: ReadonlySet<string> = new Set([
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);

/** The plugin's verification endpoints, whose `trustDevice` flag is forced off. */
const TRUST_DEVICE_STRIPPED_PATHS: ReadonlySet<string> = new Set(
  Object.keys(PLUGIN_VERIFIER_METHOD)
);

/**
 * Library paths whose body can ask for a SESSION, which this deployment does not
 * grant from an enrolment.
 *
 * `/passkey/verify-registration` takes `createSession`, and on the way out
 * `recordPasskeyEnrolment` rotates the user's sessions and keeps only the one
 * the REQUEST arrived on — so a session the plugin minted would be deleted
 * after its cookie was set, leaving the browser a token for a missing row that
 * `/get-session` still answers from the cookie cache. A session minted here
 * would also have completed no second factor.
 */
const SESSION_CREATION_STRIPPED_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
]);

/**
 * What Better Call reports as the path of an endpoint declared without one.
 * Mirrored, and it fails closed: if the placeholder changes upstream, our own
 * `auth.api.*` calls to server-only endpoints answer 404.
 */
const SERVER_ONLY_VIRTUAL_PATH = '/';

/**
 * The server-only endpoints this deployment actually calls, by the operation id
 * the dispatcher carries (`toAuthEndpoints` sets it to the `auth.api` key).
 *
 * ⚠️ A NAMED set, never a blanket pass on the placeholder path: every
 * `createAuthEndpoint.serverOnly` endpoint reports `'/'`, including
 * `viewBackupCodes`, which returns a user's DECRYPTED recovery codes for any
 * user id. Calling another one has to be a deliberate edit to this list.
 */
const SERVER_ONLY_OPERATIONS: ReadonlySet<string> = new Set(['generateTOTP']);

export async function enforcePathPolicy(
  ctx: HookContext
): Promise<{ context: unknown } | undefined> {
  const internalSchemaGeneration =
    ctx.path === '/open-api/generate-schema' && !ctx.request;
  // A server-only endpoint is never registered on the router, so it is outside
  // the surface this list bounds: `app.ts` enforces the same list before
  // `auth.handler` runs. All three conditions are required: `!ctx.request`
  // alone would exempt every `auth.api.*` call, the placeholder alone a request
  // for `/api/auth/`, and without the operation id every server-only endpoint.
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
  if (twoFactorContext) return twoFactorContext;

  if (ctx.path === '/sign-in/email') return await signInContext(ctx);
}

/**
 * Verifies the real password for `/sign-in/email` and hands the library a proof
 * in its place.
 *
 * ⚠️ The returned body is MERGED, not substituted — `runBeforeHooks` combines it
 * with the caller's through `defuReplaceArrays`, so every key named here wins
 * and every key omitted survives. `callbackURL` survives into `Location` and
 * `url`; what keeps it from being an open redirect is the library's
 * `originCheckMiddleware` against `baseURL`, not this return (asserted in
 * `tests/integration/sign-in-controls.test.ts`).
 */
async function signInContext(ctx: HookContext): Promise<{ context: unknown }> {
  const { email, password, rememberMe } = bodyRecord(ctx);

  const { success, data } = loginSchema.safeParse({
    email,
    password,
    rememberMe,
    // Already verified by the captcha plugin's `onRequest`, which runs ahead of
    // every hook.
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
    // Explicit rather than left to the merge: it decides a session lifetime
    // and has to survive into the two-factor challenge's companion record.
    rememberMe: submittedRememberMe({ rememberMe: data.rememberMe }),
  });
}

/**
 * Everything the 2FA and passkey paths need before Better Auth's own middleware
 * runs: a live session, reauthentication proof, and no client-chosen device
 * trust. One function because all three answers share the session lookup.
 */
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
      await requireLiveSession(mode.sessionId, mode.userId);
      if (
        needsGrant &&
        !(await consumeReauthGrant(ctx, {
          userId: mode.userId,
          purpose: 'two_factor_enrolment',
          token: grantToken(ctx),
        }))
      )
        throw authError(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
    } else if (needsGrant) throw sessionRequired();
  }

  if (
    !needsProof &&
    !needsLiveSession &&
    !stripsTrustDevice &&
    !stripsSessionCreation
  )
    return undefined;

  const body = bodyRecord(ctx);

  // Overwritten rather than deleted: the dispatcher MERGES the returned body,
  // so an omitted key keeps the caller's value. See `two-factor/trusted-device.ts`
  // for why the plugin's own trust record is refused. `disableSession` rides
  // along: on a sign-in verification it spends a backup code and returns
  // WITHOUT completing the challenge or re-arming the attempt counter.
  const patch: Record<string, unknown> = {
    ...(stripsTrustDevice && { trustDevice: false, disableSession: false }),
    ...(stripsSessionCreation && { createSession: false }),
  };

  if (!needsProof && !needsLiveSession)
    return withBody(ctx, { ...body, ...patch });

  const session = await readRequestSession(ctx);
  if (!session) throw sessionRequired();

  if (needsLiveSession)
    await requireLiveSession(session.sessionId, session.userId);

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

/**
 * The DATABASE, not the cookie cache: liveness is exactly the question the
 * cache cannot answer.
 */
async function requireLiveSession(
  sessionId: string,
  userId: EntityID
): Promise<void> {
  try {
    await assertLiveSession(sessionId, userId);
  } catch {
    throw sessionRequired();
  }
}

/**
 * The plugin's verifiers resolve their credential row and consult no offered
 * set, so an unacknowledged or removed backup-code set, or a TOTP confirmed
 * after the challenge was issued, would complete a sign-in the challenge never
 * offered. Sign-in mode only, the same fence `two-factor/plugin.ts` applies
 * inside the endpoint: kept in both places, because this one is keyed by path
 * and that one owns verification.
 */
async function assertPluginVerifierOffered(
  ctx: HookContext,
  method: TwoFactorMethod
): Promise<void> {
  await requireTwoFactorChallenge(ctx, { method, signInOnly: true });
}

/**
 * From the signed cookie and the database, not the cookie cache — whose answer
 * is precisely what must not be trusted here. See `LIVE_SESSION_PATHS`.
 */
async function readRequestSession(
  ctx: HookContext
): Promise<{ userId: EntityID; sessionId: string } | null> {
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret
  );
  if (!token) return null;
  const found = await ctx.context.internalAdapter.findSession(token);
  const userId = validID(found?.user.id);
  if (!found || !userId) return null;
  return { userId, sessionId: found.session.id };
}

/**
 * The bounds this schema stores under, applied to the plugin's own bodies.
 *
 * ⚠️ These paths carry the library's Zod schemas: an unbounded `name` and a
 * plain `string` id, against a `varchar(NAME_MAX)` column and UUID ids — a 500
 * where every other authenticated surface answers a 4xx envelope. `app.ts`
 * mounts one wildcard, so this hook is the only boundary a per-path schema can
 * live on.
 */
function assertPasskeyInputBounds(ctx: HookContext, path: string): void {
  if (!PASSKEY_BOUNDED_PATHS.has(path)) return;
  const body = bodyRecord(ctx);

  const name = body.name;
  // `varchar(NAME_MAX)` counts CHARACTERS, so this has to as well; the plugin's
  // own schema is `z.string().trim()`, so the trim is what reaches the column.
  const overlongName =
    typeof name === 'string' && exceedsCodePoints(name.trim(), NAME_MAX);
  const id = body.id;
  const malformedId =
    PASSKEY_ID_PATHS.has(path) && (typeof id !== 'string' || !validID(id));

  if (overlongName || malformedId)
    throw authError(HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_INPUT);
}

/** `?grant=` on the GET ceremony route, `grant` in the body on the POST ones. */
function grantToken(ctx: HookContext): unknown {
  return (
    bodyRecord(ctx).grant ??
    (ctx.query as { grant?: unknown } | undefined)?.grant
  );
}

/**
 * `passwordSchema`'s own bound, in its own unit (code points after
 * normalisation). This runs ahead of it on every Better Auth path and is all a
 * password meets before `/sign-in/email` parses it, so a different unit would
 * refuse logins with a password the rotation routes accepted.
 */
function rejectOverlongPassword(ctx: HookContext): void {
  const supplied = bodyRecord(ctx).password;
  if (
    typeof supplied !== 'string' ||
    !exceedsCodePoints(normalizePasswordInput(supplied), PASSWORD_MAX)
  )
    return;
  throw authError(HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_INPUT);
}
