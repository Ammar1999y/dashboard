import type { AuthContext } from '../context';
import type { BetterAuthPlugin } from 'better-auth';
import type { APIError } from 'better-auth/api';

import { isDeadlock } from '@/db/errors';
import { createAuthEndpoint, isAPIError } from 'better-auth/api';
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
import {
  googleStartSchema,
  OAUTH_PROVIDERS,
  OAUTH_STATE_LOST_PAGE,
} from '@app/shared/validation/oauth';
import { TWO_FACTOR_ENABLED } from '@app/shared/validation/two-factor';

import { auditLog } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { errorClassOf, logSanitized } from '@/utils/log';

import { authAuditMeta, requestHeaders } from '../context';
import {
  authenticationDenied,
  authError,
  authErrorCodeFirst,
  databaseContended,
  toAuthApiError,
} from '../errors';
import { BASE64URL_32_BYTES_PATTERN } from '../keyring';
import { envelopeResponse } from '../plugin-openapi';
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

const outcomeData = {
  type: 'object',
  properties: { loggedIn: { const: true } },
  required: ['loggedIn'],
  additionalProperties: false,
};

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
  if (isDeadlock(error)) return databaseContended(error);
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

/**
 * Everything `GET /oauth/google/callback` may hand to `GET /oauth/result`.
 *
 * A closed union, and validated on the way OUT rather than trusted: the value
 * round-trips through a `verification` row as JSON, so this is the boundary that
 * decides the endpoint's contract. Each branch is LOOSE so the fields its
 * envelope carries beyond the discriminator — the session body's user, the
 * challenge's options — survive without being restated here, where they would
 * be a second copy of two shapes owned elsewhere.
 */
const oauthResultSchema = z.union([
  z.looseObject({ success: z.literal(true) }),
  z.looseObject({ twoFactorRedirect: z.literal(true) }),
  z.looseObject({ success: z.literal(false) }),
]);

async function completeResponse(
  ctx: AuthContext,
  body: object,
  destination: string | null,
  userId: string
) {
  if (!destination) return ctx.json(body);
  const token = randomToken(32);
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: oauthResultKey(token),
    value: JSON.stringify(body),
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

export const oauth = () =>
  ({
    id: 'existing-user-oauth',
    endpoints: {
      authCapabilities: createAuthEndpoint(
        '/capabilities',
        {
          method: 'GET',
          metadata: {
            openapi: envelopeResponse('Enabled OAuth sign-in providers.', {
              type: 'object',
              properties: {
                oauthProviders: {
                  type: 'array',
                  items: { type: 'string', enum: [...OAUTH_PROVIDERS] },
                },
              },
              required: ['oauthProviders'],
              additionalProperties: false,
            }),
          },
        },
        (ctx) =>
          ctx.json({
            success: true,
            data: { oauthProviders: ENABLED_OAUTH_PROVIDERS },
          })
      ),
      ...(GOOGLE_ENABLED && {
        googleStart: createAuthEndpoint(
          '/oauth/google/start',
          {
            method: 'POST',
            body: googleStartSchema,
            metadata: {
              openapi: envelopeResponse(
                'Navigate to the returned Google authorization URL.',
                {
                  type: 'object',
                  properties: { url: { type: 'string', format: 'uri' } },
                  required: ['url'],
                }
              ),
            },
          },
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
              success: true,
              data: { url: url.href },
            });
          }
        ),
        googleCallback: createAuthEndpoint(
          '/oauth/google/callback',
          {
            method: 'GET',
            query: z.object({
              code: z.string().min(1).max(4096).optional(),
              // `generateState`'s own shape, so the lookup it drives can never
              // name one of this application's verification rows.
              state: z.string().regex(OAUTH_STATE_PATTERN),
              error: z.string().max(256).optional(),
              iss: z.string().max(255).optional(),
            }),
            metadata: {
              openapi: envelopeResponse(
                'Google sign-in result or local two-factor challenge. A supplied callbackURL receives a redirect; retrieve the result once at /oauth/result.',
                outcomeData
              ),
            },
          },
          async (ctx) => {
            let destination: string | null = null;
            let stage = 'state';
            let readingState = false;
            try {
              if (!googleProvider || !GOOGLE_CREDENTIALS)
                throw authenticationDenied();
              readingState = true;
              const state = await parseState(ctx);
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
              const tokens = await googleProvider
                .validateAuthorizationCode({
                  code: ctx.query.code,
                  codeVerifier: state.codeVerifier,
                  redirectURI: GOOGLE_REDIRECT_URI,
                })
                .catch((error: unknown) => {
                  throw isTokenEndpointRefusal(error)
                    ? new GoogleIdentityDenied('token_exchange_refused')
                    : error;
                });
              if (typeof tokens.idToken !== 'string' || !tokens.idToken)
                throw new GoogleProviderFault('token_response_malformed');
              stage = 'token_verification';
              const claims = await verifyGoogleIdToken({
                token: tokens.idToken,
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
                  { success: true, data: { loggedIn: true } },
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
              const failure = serverFailure(error, readingState);
              if (failure) {
                // `parseState` redirects into these headers; its `Location` would otherwise ride on the 5xx.
                ctx.responseHeaders?.delete('location');
                logSanitized('error', {
                  msg: 'oauth.signIn.failed',
                  provider: 'google',
                  stage,
                  reason: readingState
                    ? 'state_unavailable'
                    : error instanceof GoogleProviderFault
                      ? error.kind
                      : 'unexpected_failure',
                  // The class only: a provider or driver message can carry credentials or SQL parameters.
                  errorClass: errorClassOf(error),
                  providerError: tokenEndpointErrorCode(error),
                });
                throw failure;
              }
              const denial = error instanceof GoogleIdentityDenied;
              const stateLost = readingState && isLostState(error);
              logSanitized(denial || stateLost ? 'warn' : 'error', {
                msg: 'oauth.signIn.failed',
                provider: 'google',
                stage,
                reason: denial
                  ? error.reason
                  : stateLost
                    ? 'state_lost'
                    : 'authentication_denied',
              });
              if (destination)
                return completeResponse(
                  ctx,
                  { success: false },
                  destination,
                  '-'
                );
              if (stateLost)
                return ctx.redirect(`${PUBLIC_ORIGIN}${OAUTH_STATE_LOST_PAGE}`);
              // `parseState` answers with a redirect into these headers, and
              // its `Location` would otherwise ride on the 401.
              ctx.responseHeaders?.delete('location');
              throw authenticationDenied();
            }
          }
        ),
        oauthResult: createAuthEndpoint(
          '/oauth/result',
          {
            method: 'GET',
            metadata: {
              openapi: envelopeResponse(
                'Consume the Google redirect result once.',
                outcomeData
              ),
            },
          },
          async (ctx) => {
            const cookie = ctx.context.createAuthCookie('oauth_result');
            const token = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret
            );
            if (!token || !BASE64URL_32_BYTES_PATTERN.test(token))
              throw authenticationDenied();
            expireCookie(ctx, cookie);
            const owner =
              await ctx.context.internalAdapter.consumeVerificationValue(
                oauthResultOwnerKey(token)
              );
            const result =
              await ctx.context.internalAdapter.consumeVerificationValue(
                oauthResultKey(token)
              );
            if (!owner || !result) throw authenticationDenied();
            const parsed = oauthResultSchema.safeParse(
              JSON.parse(result.value)
            );
            // Both records are consumed, so a rejection is unrecoverable: every
            // envelope the callback stores has to be a branch of the union.
            if (!parsed.success) {
              logSanitized('error', { msg: 'oauth.result.unrecognised' });
              throw authenticationDenied();
            }
            // The same denial the direct callback answers, so both modes share one failure envelope.
            if (parsed.data.success === false) throw authenticationDenied();
            return ctx.json(parsed.data);
          }
        ),
      }),
    },
  }) satisfies BetterAuthPlugin;
