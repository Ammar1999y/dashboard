import type { AuthContext } from '../context';
import type { BetterAuthPlugin } from 'better-auth';
import type { APIError } from 'better-auth/api';

import { and, eq, gt } from 'drizzle-orm';

import { db } from '@/db';
import { isDatabaseContention } from '@/db/errors';
import { verifications } from '@/db/schema';
import { isAPIError } from 'better-auth/api';
import { deleteSessionCookie, expireCookie } from 'better-auth/cookies';
import { generateState, parseState } from 'better-auth/oauth2';
import { google } from 'better-auth/social-providers';
import * as z from 'zod';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
} from '@app/shared/messages/common';
import { oauthOutcomeSchema } from '@app/shared/responses/better-auth';
import {
  googleStartSchema,
  OAUTH_STATE_LOST_PAGE,
} from '@app/shared/validation/oauth';
import { TWO_FACTOR_ENABLED } from '@app/shared/validation/two-factor';

import { auditLog } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { customErrorFields, errorClassOf, logSanitized } from '@/utils/log';

import { authAuditMeta, requestHeaders } from '../context';
import {
  authenticationDenied,
  authError,
  authErrorCodeFirst,
  databaseUnavailable,
  toAuthApiError,
} from '../errors';
import { BASE64URL_32_BYTES_PATTERN } from '../keyring';
import { pluginEndpoint } from '../plugin-endpoint';
import { recordAbandonedSession } from '../session/audit';
import { authenticationStartedAt } from '../session/authentication-time';
import { deliverSessionCookie } from '../session/cookie';
import { assertLiveSession } from '../session/live';
import { submittedRememberMe } from '../session/remember-me';
import { withAuthTransaction } from '../transaction';
import { issueTwoFactorChallenge } from '../two-factor/issue';
import { readEnrolmentState } from '../two-factor/methods';
import {
  expiresIn,
  oauthOnceKey,
  oauthResultKey,
  oauthResultOwnerKey,
  randomToken,
} from '../verifications';
import {
  ENABLED_OAUTH_PROVIDERS,
  GOOGLE_CREDENTIALS,
  GOOGLE_ENABLED,
} from './config';
import { GoogleProviderFault, verifyGoogleIdToken } from './id-token';
import {
  GOOGLE_ISSUER,
  googleIdentity,
  GoogleIdentityDenied,
  resolveGoogleIdentity,
} from './identity';
import { exchangeGoogleCode } from './token-exchange';

/** `generateState`'s token: 32 of `generateRandomString`'s `a-z0-9A-Z-_`. */
const OAUTH_STATE_PATTERN = /^[\w-]{32}$/;

const GOOGLE_REDIRECT_URI = `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback`;

/** The lifetime of the signed state cookie `generateState` sets, which bounds the round trip. */
const OAUTH_STATE_MAX_AGE_S = 300;

/** The redirect result, retrieved once by the page the callback lands on. */
const OAUTH_RESULT_MAX_AGE_S = 60;

const flowSchema = z.object({
  startedAt: z.number(),
  rememberMe: z.boolean(),
  returnURL: z.string().nullable(),
});

const googleProvider = GOOGLE_CREDENTIALS
  ? google({
      ...GOOGLE_CREDENTIALS,
      disableDefaultScope: true,
      scope: ['openid', 'email'],
      accessType: 'online',
      includeGrantedScopes: false,
      disableSignUp: true,
    })
  : null;

/**
 * `parseState` answers every failure with a redirect whose `error` names it. A
 * database fault is not a lost state, so it is not sent to "start again".
 */
function isLostState(error: unknown): boolean {
  if (!isAPIError(error)) return false;
  const location = new Headers(error.headers).get('location');
  const code = location ? URL.parse(location)?.searchParams.get('error') : null;
  return typeof code === 'string' && code !== 'internal_server_error';
}

/**
 * `parseState`, with its failure line handed to `onFailure` rather than the
 * logger: the redirect it throws drops the cause, so the callback logs that
 * line as its own, once. The library logs nothing else there.
 */
function parseStateLoggingTo(
  ctx: Parameters<typeof parseState>[0],
  onFailure: (logged: unknown) => void
) {
  return parseState({
    ...ctx,
    context: {
      ...ctx.context,
      logger: {
        ...ctx.context.logger,
        error: (_message: string, logged?: unknown) => onFailure(logged),
      },
    },
  });
}

/** A `StateError`'s code (the class is not exported), or undefined. */
function stateCodeOf(logged: unknown): string | undefined {
  const code: unknown =
    typeof logged === 'object' && logged !== null
      ? Reflect.get(logged, 'code')
      : undefined;
  return typeof code === 'string' && /^state_[a-z_]{1,40}$/.test(code)
    ? code
    : undefined;
}

/**
 * The answer for a fault that says nothing about the credentials, or undefined
 * when the failure is a refusal. A refusal is `GoogleIdentityDenied` or an
 * `APIError` below 500; everything else is infrastructure and must not read as
 * "sign-in refused", with or without a callbackURL to redirect to.
 */
function serverFailure(
  error: unknown,
  readingState: boolean
): APIError | undefined {
  if (error instanceof GoogleIdentityDenied) return undefined;
  if (isDatabaseContention(error)) return databaseUnavailable();
  if (error instanceof CustomError) {
    const status = error.status ?? HTTP_STATUS.INTERNAL_ERROR;
    return status === HTTP_STATUS.SERVICE_UNAVAILABLE
      ? toAuthApiError(error, MSG_INTERNAL_ERROR)
      : status >= HTTP_STATUS.INTERNAL_ERROR
        ? authError(HTTP_STATUS.INTERNAL_ERROR, MSG_INTERNAL_ERROR)
        : undefined;
  }
  if (isAPIError(error)) {
    if (error.statusCode >= HTTP_STATUS.INTERNAL_ERROR) return error;
    return readingState && !isLostState(error)
      ? authError(HTTP_STATUS.INTERNAL_ERROR, MSG_INTERNAL_ERROR)
      : undefined;
  }
  return authError(HTTP_STATUS.INTERNAL_ERROR, MSG_INTERNAL_ERROR);
}

/**
 * What a failure line keeps besides the class: a database fault (driver errors
 * are logged without their bound values), or the diagnosis one of ours carries.
 */
function faultDetail(error: unknown): Record<string, unknown> {
  if (isDatabaseContention(error)) return { fault: error };
  if (error instanceof CustomError) return customErrorFields(error);
  return {};
}

/** RFC 6749 section 5.2 codes, the only provider text safe to log: free-text fields can carry anything. */
const TOKEN_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

/**
 * Better Auth throws the token endpoint's 4xx answer as betterFetch's plain
 * `{ ...body, status, statusText }` object, not an `Error`.
 */
function tokenEndpointErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    error instanceof Error ||
    !('error' in error) ||
    typeof error.error !== 'string' ||
    !TOKEN_ERROR_CODES.has(error.error)
  )
    return undefined;
  return error.error;
}

/**
 * Only `invalid_grant` blames the code the user presented (expired, replayed,
 * PKCE mismatch: RFC 6749 section 5.2, Google's token endpoint table). Every
 * other code, an absent one, a 5xx and a thrown `Error` describe this server's
 * client configuration or the provider, and must not read as a refused sign-in.
 */
function isTokenEndpointRefusal(error: unknown): boolean {
  return (
    tokenEndpointErrorCode(error) === 'invalid_grant' &&
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= HTTP_STATUS.BAD_REQUEST &&
    error.status < HTTP_STATUS.INTERNAL_ERROR
  );
}

function returnURL(input: string | undefined) {
  if (!input) return null;
  const url = URL.parse(input, PUBLIC_ORIGIN);
  if (
    !url ||
    url.origin !== PUBLIC_ORIGIN ||
    url.username ||
    url.password ||
    url.hash
  )
    throw authenticationDenied();
  return url.href;
}

type OAuthOutcome = z.output<typeof oauthOutcomeSchema>;

/** Kept in place of an outcome when the sign-in was refused; never answered. */
const refusalSchema = z.object({ success: z.literal(false) });

/**
 * Everything `GET /oauth/google/callback` may hand to `GET /oauth/result`: the
 * published outcome, or the refusal marker, which the result answers with the
 * same 401 as the direct callback. Parsed when it is written as well as when
 * it is read: a body the reader would refuse is refused before it is kept, while
 * the callback can still answer for it, and not after both rows are consumed.
 */
const keptResultSchema = z.union([oauthOutcomeSchema, refusalSchema]);

type KeptResult = z.output<typeof keptResultSchema>;

const isRefusal = (kept: KeptResult): kept is z.output<typeof refusalSchema> =>
  'success' in kept && !kept.success;

/** Keeps `result` for `GET /oauth/result` and sends the browser on to `destination`. */
async function keepForResult(
  ctx: AuthContext,
  result: KeptResult,
  destination: string,
  userId: string
) {
  const value = JSON.stringify(keptResultSchema.parse(result));
  const token = randomToken(32);
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: oauthResultKey(token),
    value,
    expiresAt: expiresIn(OAUTH_RESULT_MAX_AGE_S),
  });
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: oauthResultOwnerKey(token),
    // The user-valued companion lets credential rotation invalidate the pending result without parsing its body.
    value: userId,
    expiresAt: expiresIn(OAUTH_RESULT_MAX_AGE_S),
  });
  const cookie = ctx.context.createAuthCookie('oauth_result', {
    maxAge: OAUTH_RESULT_MAX_AGE_S,
  });
  await ctx.setSignedCookie(
    cookie.name,
    token,
    ctx.context.secret,
    cookie.attributes
  );
  return ctx.redirect(destination);
}

/** The outcome as the direct callback answers it, or kept behind a redirect. */
async function completeResponse(
  ctx: AuthContext,
  outcome: OAuthOutcome,
  destination: string | null,
  userId: string
) {
  if (!destination) return ctx.json(outcome);
  return keepForResult(ctx, outcome, destination, userId);
}

export const oauth = () =>
  ({
    id: 'existing-user-oauth',
    endpoints: {
      authCapabilities: pluginEndpoint(
        '/capabilities',
        { method: 'GET' },
        (ctx) =>
          ctx.json({
            data: { oauthProviders: ENABLED_OAUTH_PROVIDERS },
          })
      ),
      ...(GOOGLE_ENABLED && {
        googleStart: pluginEndpoint(
          '/oauth/google/start',
          { method: 'POST', body: googleStartSchema },
          async (ctx) => {
            if (!googleProvider) throw authenticationDenied();
            if (!(await verifyTurnstileRequest(requestHeaders(ctx))))
              throw authErrorCodeFirst(
                HTTP_STATUS.FORBIDDEN,
                MSG_INVALID_INPUT
              );
            const destination = returnURL(ctx.body.callbackURL);
            const nonce = randomToken(32);
            const { state, codeVerifier } = await generateState(ctx, {
              idTokenNonce: nonce,
              additionalData: {
                flow: {
                  startedAt: await authenticationStartedAt(),
                  rememberMe: submittedRememberMe(ctx.body),
                  returnURL: destination,
                },
              },
            });
            // Better Auth consumes redirect state by read/delete; this marker makes concurrent callbacks single-use.
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: oauthOnceKey(state),
              value: '-',
              expiresAt: expiresIn(OAUTH_STATE_MAX_AGE_S),
            });
            const url = await googleProvider.createAuthorizationURL({
              state,
              codeVerifier,
              redirectURI: GOOGLE_REDIRECT_URI,
              additionalParams: {
                claims: JSON.stringify({
                  id_token: {
                    amr: { essential: true },
                  },
                }),
              },
            });
            url.searchParams.set('nonce', nonce);
            return ctx.json({
              data: { url: url.href },
            });
          }
        ),
        googleCallback: pluginEndpoint(
          '/oauth/google/callback',
          {
            method: 'GET',
            query: z.object({
              code: z.string().min(1).max(4096).optional(),
              // `generateState`'s own shape. Not proof the state is ours: a
              // passkey challenge row shares it, hence the marker check below.
              state: z.string().regex(OAUTH_STATE_PATTERN),
              error: z.string().max(256).optional(),
              iss: z.string().max(255).optional(),
            }),
          },
          async (ctx) => {
            let destination: string | null = null;
            let stage = 'state';
            let readingState = false;
            let stateFailure: unknown;
            try {
              if (!googleProvider || !GOOGLE_CREDENTIALS)
                throw authenticationDenied();
              readingState = true;
              // `parseState` parses whatever verification row the value names,
              // and answers any other row's value with a 500. Only one the
              // start endpoint marked is read.
              const [issued] = await db
                .select({ id: verifications.id })
                .from(verifications)
                .where(
                  and(
                    eq(verifications.identifier, oauthOnceKey(ctx.query.state)),
                    gt(verifications.expiresAt, new Date())
                  )
                )
                .limit(1);
              if (!issued) throw new GoogleIdentityDenied('state_lost');
              const state = await parseStateLoggingTo(ctx, (logged) => {
                stateFailure = logged;
              });
              readingState = false;
              const flow = flowSchema.parse(state.flow);
              destination = returnURL(flow.returnURL ?? undefined);
              const once =
                await ctx.context.internalAdapter.consumeVerificationValue(
                  oauthOnceKey(ctx.query.state)
                );
              // Everything a caller can produce by hand is a refusal named for the log; none of it is a fault of this server.
              if (!once) throw new GoogleIdentityDenied('state_replayed');
              if (ctx.query.error)
                throw new GoogleIdentityDenied(
                  ctx.query.error === 'access_denied'
                    ? 'user_cancelled'
                    : 'authorization_error'
                );
              if (ctx.query.iss && ctx.query.iss !== GOOGLE_ISSUER)
                throw new GoogleIdentityDenied('issuer_mismatch');
              if (!ctx.query.code)
                throw new GoogleIdentityDenied('code_missing');
              if (!state.idTokenNonce) throw authenticationDenied();
              stage = 'token_exchange';
              const idToken = await exchangeGoogleCode({
                code: ctx.query.code,
                codeVerifier: state.codeVerifier,
                redirectURI: GOOGLE_REDIRECT_URI,
                credentials: GOOGLE_CREDENTIALS,
              }).catch((error: unknown) => {
                throw isTokenEndpointRefusal(error)
                  ? new GoogleIdentityDenied('token_exchange_refused')
                  : error;
              });
              stage = 'token_verification';
              const claims = await verifyGoogleIdToken({
                token: idToken,
                audience: GOOGLE_CREDENTIALS.clientId,
                nonce: state.idTokenNonce,
              });
              stage = 'identity';
              const identity = googleIdentity(claims);
              const meta = authAuditMeta(ctx);
              let recordRefusal: (() => Promise<void>) | undefined;
              const result = await withAuthTransaction(ctx, async (tx) => {
                const user = await resolveGoogleIdentity(
                  tx,
                  identity,
                  flow.startedAt,
                  meta
                );
                const bypassTwoFactor = TWO_FACTOR_ENABLED && identity.mfa;
                const enrolled = bypassTwoFactor
                  ? await readEnrolmentState(user.id, tx)
                  : null;
                const session = await ctx.context.internalAdapter.createSession(
                  user.id,
                  !flow.rememberMe
                );
                if (!session) throw authenticationDenied();
                if (enrolled?.enabled)
                  await auditLog(tx, {
                    userId: user.id,
                    userEmail: user.email,
                    action: 'INSERT',
                    tableName: 'sessions',
                    recordId: session.id,
                    oldData: null,
                    newData: {
                      firstFactor: 'google',
                      twoFactorBypass: 'google_mfa',
                      reason: 'two_factor_skipped_google_mfa',
                    },
                    meta,
                  });
                const outcome = bypassTwoFactor
                  ? null
                  : await issueTwoFactorChallenge(ctx, {
                      userId: user.id,
                      userEmail: user.email,
                      session,
                      firstFactor: 'google',
                      transaction: tx,
                      // Google is admitted only as the authority for this mailbox, so a code sent there proves nothing more.
                      excludeContactKind: 'email',
                      rememberMe: flow.rememberMe,
                      auditMeta: meta,
                    });
                if (outcome?.kind === 'refused') {
                  recordRefusal = outcome.recordRefusal;
                  throw authenticationDenied();
                }
                return { user, session, outcome };
              }).catch(async (error: unknown) => {
                await recordRefusal?.();
                throw error;
              });
              const session = result.session;
              if (!session) throw authenticationDenied();
              stage = 'post_commit_admission';
              try {
                if (result.outcome?.kind === 'challenge') {
                  stage = 'result_delivery';
                  return await completeResponse(
                    ctx,
                    result.outcome.body,
                    destination,
                    result.user.id
                  );
                }
                await assertLiveSession(session.id, result.user.id);
                const user = await ctx.context.internalAdapter.findUserById(
                  result.user.id
                );
                if (!user || user.email !== identity.email)
                  throw authenticationDenied();
                stage = 'cookie_delivery';
                await deliverSessionCookie(
                  ctx,
                  { session, user },
                  flow.rememberMe
                );
                stage = 'result_delivery';
                return await completeResponse(
                  ctx,
                  { data: { loggedIn: true } },
                  destination,
                  result.user.id
                );
              } catch (error) {
                try {
                  await ctx.context.internalAdapter.deleteSession(
                    session.token
                  );
                } finally {
                  deleteSessionCookie(ctx, true);
                  await recordAbandonedSession({
                    userId: result.user.id,
                    userEmail: result.user.email,
                    sessionId: session.id,
                    auditMeta: meta,
                    reason:
                      stage === 'post_commit_admission'
                        ? 'post_commit_admission_failed'
                        : stage === 'result_delivery'
                          ? 'result_delivery_failed'
                          : 'cookie_delivery_failed',
                  });
                }
                throw error;
              }
            } catch (error) {
              // What `parseState` caught, when its redirect stands for a fault
              // rather than a lost state: the redirect drops the cause, so the
              // answer and the line are both derived from the fault itself.
              const fault =
                readingState &&
                stateFailure !== undefined &&
                !isLostState(error)
                  ? stateFailure
                  : error;
              const failure = serverFailure(fault, readingState);
              const denial = error instanceof GoogleIdentityDenied;
              const stateLost = denial
                ? error.reason === 'state_lost'
                : readingState && isLostState(error);
              // After both reads: `parseState`'s redirect sets its `Location`
              // on these headers, which its thrown error shares, and it must
              // not ride on whatever is answered instead.
              ctx.responseHeaders?.delete('location');
              if (failure) {
                logSanitized('error', {
                  msg: 'oauth.signIn.failed',
                  provider: 'google',
                  stage,
                  reason: readingState
                    ? 'state_unavailable'
                    : error instanceof GoogleProviderFault
                      ? error.kind
                      : 'unexpected_failure',
                  // The class and what `faultDetail` keeps: a provider or driver
                  // message can carry credentials or SQL parameters.
                  errorClass: errorClassOf(fault),
                  providerError: tokenEndpointErrorCode(error),
                  ...faultDetail(fault),
                });
                throw failure;
              }
              const stateCode = stateLost
                ? stateCodeOf(stateFailure)
                : undefined;
              logSanitized(denial || stateLost ? 'warn' : 'error', {
                msg: 'oauth.signIn.failed',
                provider: 'google',
                stage,
                reason: denial
                  ? error.reason
                  : stateLost
                    ? 'state_lost'
                    : 'authentication_denied',
                ...(stateCode && { stateCode }),
              });
              if (destination)
                return keepForResult(ctx, { success: false }, destination, '-');
              if (stateLost)
                return ctx.redirect(`${PUBLIC_ORIGIN}${OAUTH_STATE_LOST_PAGE}`);
              throw authenticationDenied();
            }
          }
        ),
        oauthResult: pluginEndpoint(
          '/oauth/result',
          { method: 'GET' },
          async (ctx) => {
            const cookie = ctx.context.createAuthCookie('oauth_result');
            const token = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret
            );
            if (!token || !BASE64URL_32_BYTES_PATTERN.test(token))
              throw authenticationDenied();
            // Together, and the cookie kept until they commit: a fault between
            // two separate consumes would leave the result unreadable for the
            // retry its 503 invites.
            const { owner, result } = await withAuthTransaction(
              ctx,
              async () => ({
                owner:
                  await ctx.context.internalAdapter.consumeVerificationValue(
                    oauthResultOwnerKey(token)
                  ),
                result:
                  await ctx.context.internalAdapter.consumeVerificationValue(
                    oauthResultKey(token)
                  ),
              })
            );
            expireCookie(ctx, cookie);
            if (!owner || !result) throw authenticationDenied();
            const parsed = keptResultSchema.safeParse(JSON.parse(result.value));
            // Both records are consumed, so a rejection is unrecoverable; the
            // callback parses what it keeps for this reason.
            if (!parsed.success) {
              logSanitized('error', { msg: 'oauth.result.unrecognised' });
              throw authenticationDenied();
            }
            // The same denial the direct callback answers, so both modes share one failure envelope.
            if (isRefusal(parsed.data)) throw authenticationDenied();
            return ctx.json(parsed.data);
          }
        ),
      }),
    },
  }) satisfies BetterAuthPlugin;
