/**
 * The plugin's sign-in hook is replaced because `/passwordless/verify` must
 * issue the same challenge; `issue.ts` is the only issuer.
 *
 * `otpOptions` stays unset on purpose: that keeps `/two-factor/send-otp` and
 * `/two-factor/verify-otp` inert, so second-factor codes run on `lib/otp`.
 */
import type { AuthContext } from '../context';
import type { ResolvedChallenge } from './challenge';
import type { TotpVerdict } from './totp-replay';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { BetterAuthPlugin } from 'better-auth';

import { withTransaction } from '@/db';
import { passkey } from '@better-auth/passkey';
import {
  createAuthEndpoint,
  createAuthMiddleware,
  isAPIError,
} from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';

import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { validID } from '@app/shared/utils';
import {
  isTwoFactorMethodEnabled,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_AVAILABLE,
} from '@app/shared/validation/two-factor';

import { PUBLIC_ORIGIN } from '@/lib/env';

import { logSanitized } from '@/utils/log';

import { authAuditMeta, bodyRecord } from '../context';
import { authError } from '../errors';
import { RP_ID } from '../passkey-assertion';
import { expireDontRememberMarker } from '../session/cookie';
import { submittedRememberMe } from '../session/remember-me';
import { resolveRequestSession } from '../session/request';
import { transactionBoundContext } from '../transaction';
import { spendBackupCode } from './backup-codes';
import {
  challengeMissingError,
  PLUGIN_VERIFIER_METHOD,
  recordPluginCompletion,
  requireTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_MAX_AGE_S,
  withTwoFactorChallengeTransaction,
} from './challenge';
import { TOTP_ISSUER, twoFactorEnrolment } from './enrolment';
import { issueTwoFactorChallenge, twoFactorUnavailableError } from './issue';
import { auditLifecycle, recordPasskeyEnrolment } from './lifecycle';
import { twoFactorOtp } from './otp';
import { twoFactorPasskey } from './passkey';
import {
  consumeTotpCode,
  DELEGATED_TOTP_WINDOW,
  readVerifiedTotpSecret,
} from './totp-replay';
import { markTwoFactorProven, trustedDevice } from './trusted-device';

// Must equal the `db/schema.ts` export name: the adapter resolves `schema[modelName]`.
const TWO_FACTOR_TABLE = 'twoFactorCredentials';

// Duplicates `assertPluginVerifierOffered` (`path-policy.ts`) on purpose: that
// fence is keyed by path, and this endpoint owns verification.
function requireVerifierChallenge(
  ctx: AuthContext
): Promise<ResolvedChallenge> {
  return requireTwoFactorChallenge(ctx, { signInOnly: true });
}

/**
 * `context` whose `internalAdapter` records the first fault any call raises.
 * The plugin swallows some: `beginAttempt` answers a failed counter consume
 * with 401 and drops a failed re-arm, so the fault would read as a refusal.
 */
function recordingFaults(context: AuthContext['context']) {
  const seen: { fault?: { error: unknown } } = {};
  const record = (error: unknown) => {
    seen.fault ??= { error };
    return error;
  };
  const adapter = new Proxy(context.internalAdapter, {
    get: (target, property, receiver) => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result: unknown = Reflect.apply(value, target, args);
          return result instanceof Promise
            ? result.catch((error: unknown) => {
                throw record(error);
              })
            : result;
        } catch (error) {
          throw record(error);
        }
      };
    },
  });
  return {
    context: new Proxy(context, {
      get: (target, property) =>
        property === 'internalAdapter'
          ? adapter
          : Reflect.get(target, property),
    }),
    fault: () => seen.fault,
  };
}

/**
 * The caller resolves the challenge so work that must stay outside the
 * transaction (the TOTP step reservation) can run first. `verify` must pass its
 * bound `context` to the endpoint it delegates to.
 */
async function runPluginVerifier<T>(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  verify: (context: AuthContext['context'], tx: Tx) => Promise<T>
) {
  const result = await withTwoFactorChallengeTransaction(
    ctx,
    challenge,
    async (tx) => {
      const watched = recordingFaults(
        await transactionBoundContext(ctx.context)
      );
      let outcome: { response: T } | { error: unknown };
      try {
        outcome = { response: await verify(watched.context, tx) };
      } catch (error) {
        outcome = { error };
      }
      // Ahead of the answer: a fault the plugin swallowed, or one a later
      // statement reports only as the aborted transaction, is answered as itself.
      const fault = watched.fault();
      if (fault) throw fault.error;
      // Invalid-code attempts must commit their counters before returning the error.
      if ('error' in outcome && !isAPIError(outcome.error)) throw outcome.error;
      return outcome;
    }
  );
  if (!result) throw challengeMissingError();
  if ('error' in result) throw result.error;
  return result.response;
}

// Stands in for a spent code. `generateHOTP` emits decimal digits only, so no
// secret matches it and a replay walks the same wrong-code path as a guess.
const SPENT_TOTP_CODE = 'spent!';

/**
 * Reads the credential itself: the plugin has no hook between "code valid" and
 * "session issued". Every failure answers `'rejected'` so the library still
 * gives its own answer and counters.
 *
 * ⚠️ Runs BEFORE the challenge transaction, so a claimed step stays spent even
 * if the request later rolls back (deliberate). Moving it inside means passing
 * the transaction's executor — see `consumeTotpCode`.
 */
async function reserveSignInTotpStep(
  ctx: AuthContext,
  userId: EntityID
): Promise<TotpVerdict> {
  const { code } = bodyRecord(ctx);
  if (typeof code !== 'string') return 'rejected';

  const secret = await readVerifiedTotpSecret(userId, ctx.context.secretConfig);
  if (!secret) return 'rejected';

  return consumeTotpCode(userId, secret, code, {
    window: DELEGATED_TOTP_WINDOW,
  });
}

function forwardVerifierHeaders(ctx: AuthContext, headers: Headers) {
  for (const cookie of headers.getSetCookie())
    ctx.responseHeaders?.append('set-cookie', cookie);
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') ctx.responseHeaders?.set(name, value);
  });
}

// `/passkey/verify-registration` answers with the persisted `Passkey` row; its
// `id` is the only name for the credential the ceremony produced.
function registeredPasskeyId(returned: unknown): EntityID | null {
  if (!returned || typeof returned !== 'object' || !('id' in returned))
    return null;
  return validID(returned.id) || null;
}

/**
 * ⚠️ Installed unconditionally, even with no methods enabled:
 * `/passwordless/verify` calls the issuer directly, so this path must keep
 * asking it too. `issueTwoFactorChallenge` owns the empty-list decision.
 */
const twoFactorSignInGuard = () =>
  ({
    id: 'two-factor-sign-in-guard',
    hooks: {
      after: [
        {
          matcher: (context) => context.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const newSession = ctx.context.newSession;
            if (!newSession) return;

            const rememberMe = submittedRememberMe(ctx.body);
            const outcome = await issueTwoFactorChallenge(ctx, {
              userId: newSession.user.id,
              userEmail: newSession.user.email,
              session: {
                id: newSession.session.id,
                token: newSession.session.token,
              },
              firstFactor: 'password',
              rememberMe,
              auditMeta: authAuditMeta(ctx, ctx.path ?? '/sign-in/email'),
            });

            if (outcome.kind === 'refused') throw twoFactorUnavailableError();
            if (outcome.kind === 'proceed') {
              // The library's own `setSessionCookie` never clears a marker an
              // earlier "do not remember" login left in this browser.
              if (rememberMe)
                expireDontRememberMarker(ctx, { onlyIfSent: true });
              return;
            }

            return ctx.json(outcome.body);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

const twoFactorAuth = () => {
  // Destructured rather than deleted so a second hook added upstream lands in
  // this binding instead of slipping in unnoticed.
  const { hooks: _pluginSignInHook, ...core } = twoFactor({
    twoFactorTable: TWO_FACTOR_TABLE,
    issuer: TOTP_ISSUER,
    twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_MAX_AGE_S,
    // Second layer: the allow-list already answers these paths 404.
    totpOptions: { disable: !isTwoFactorMethodEnabled('totp') },
    // Left unset on purpose — see the note at the top of this file.
    otpOptions: undefined,
  });

  // ⚠️ Removed, not merely un-allow-listed: `enrolment.ts` serves the disable
  // and backup-code paths, and a duplicate path resolves by plugin order.
  // `enableTwoFactor` writes the flag and the credential separately.
  const {
    enableTwoFactor: _enable,
    disableTwoFactor: _disable,
    generateBackupCodes: _generateBackupCodes,
    ...endpoints
  } = core.endpoints;

  return {
    ...core,
    endpoints: {
      ...endpoints,
      verifyTOTP: createAuthEndpoint(
        endpoints.verifyTOTP.path,
        { ...endpoints.verifyTOTP.options, use: [] },
        async (ctx) => {
          const challenge = await requireVerifierChallenge(ctx);

          // Reserved before the library verifies, since afterwards there is a
          // session to undo. Every verdict still reaches the library, which owns
          // the attempt counter, lockout and invalid-code answer.
          const reserved = await reserveSignInTotpStep(ctx, challenge.user.id);

          const result = await runPluginVerifier(
            ctx,
            challenge,
            async (context) => {
              const verified = await endpoints.verifyTOTP({
                ...ctx,
                // Delegated as a wrong code, not refused here, so a replay
                // costs an attempt; a free replay tells the holder the capture
                // was good.
                body:
                  reserved === 'replayed'
                    ? { ...ctx.body, code: SPENT_TOTP_CODE }
                    : ctx.body,
                context,
                returnHeaders: true,
              });

              // ⚠️ Invariant: an accepted TOTP sign-in spent a step. The two
              // verifiers read the clock and credential row at different
              // instants, so it is checked. A plain `Error` rolls the new
              // session back; an `APIError` would commit it.
              if (reserved !== 'matched')
                throw new Error(
                  'TOTP verification accepted a step the replay reservation did not claim'
                );
              return verified;
            }
          );
          forwardVerifierHeaders(ctx, result.headers);
          return ctx.json(result.response);
        }
      ),
      verifyBackupCode: createAuthEndpoint(
        endpoints.verifyBackupCode.path,
        { ...endpoints.verifyBackupCode.options, use: [] },
        async (ctx) => {
          const challenge = await requireVerifierChallenge(ctx);
          const result = await runPluginVerifier(
            ctx,
            challenge,
            async (context, tx) => {
              const verified = await endpoints.verifyBackupCode({
                ...ctx,
                context,
                returnHeaders: true,
              });
              // The library throws on a code it did not spend, so this is the
              // rewrite of the set, and the count moves with it.
              await spendBackupCode(challenge.user.id, tx);
              return verified;
            }
          );
          forwardVerifierHeaders(ctx, result.headers);
          return ctx.json(result.response);
        }
      ),
    },
    hooks: {
      after: [
        {
          // The library's verifiers bypass `completeTwoFactorChallenge`, so its
          // tail (device-trust proof, completion event, companion rows) runs here.
          matcher: (context) =>
            context.path !== undefined &&
            context.path in PLUGIN_VERIFIER_METHOD,
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const newSession = ctx.context.newSession;
            const completedWith = PLUGIN_VERIFIER_METHOD[ctx.path];
            if (!newSession || !completedWith) return;
            await markTwoFactorProven(ctx, newSession.session.id);
            await recordPluginCompletion(ctx, completedWith, newSession);
          }),
        },
        {
          // The one read that clones the second factor. Not caught: a
          // disclosure that cannot be recorded is refused instead.
          matcher: (context) => context.path === '/two-factor/get-totp-uri',
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const requestSession = await resolveRequestSession(ctx);
            if (!requestSession) throw challengeMissingError();
            await withTransaction((tx) =>
              auditLifecycle(tx, ctx, requestSession, {
                twoFactorSecretDisclosed: true,
              })
            );
          }),
        },
        {
          // A registered passkey is a second factor only once recorded as one;
          // the plugin persists the credential without that intent.
          matcher: (context) => context.path === '/passkey/verify-registration',
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const requestSession = await resolveRequestSession(ctx);
            if (!requestSession) return;
            const credentialId = registeredPasskeyId(ctx.context.returned);
            const result = credentialId
              ? await recordPasskeyEnrolment(ctx, requestSession, credentialId)
              : null;
            if (result?.outcome === 'recorded') return;
            logSanitized('error', {
              msg: 'twoFactor.enrolPasskey.intentUnrecorded',
              userId: requestSession.userId,
              effect: result
                ? result.outcome === 'no-passkey'
                  ? 'the credential was deleted before it could be enrolled'
                  : 'the credential exists but is not offered as a factor'
                : 'the registration response did not name the credential it wrote',
              ...(result?.outcome === 'failed' && { cause: result.cause }),
            });
            // Replaces the registration's 200, which claimed a factor was added.
            // The credential is deliberately NOT removed on `'failed'`: a
            // compensating write after a failed write is the least likely to
            // succeed, and the authenticator already holds the credential.
            const credentialGone = result?.outcome === 'no-passkey';
            throw authError(
              credentialGone
                ? HTTP_STATUS.CONFLICT
                : HTTP_STATUS.INTERNAL_ERROR,
              credentialGone
                ? twoFactorMsg.passkeyNotSaved
                : twoFactorMsg.passkeyNotEnrolled
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};

/**
 * Registration and management only; endpoints removed from the map, not just
 * the allow-list. `verifyPasskeyAuthentication` mints a session from a
 * credential id alone. `deletePasskey` is served by `enrolment.ts` with the
 * last-method rule.
 *
 * ⚠️ The library only logs a duplicate path and resolves it by plugin order, so
 * dropping the `deletePasskey` destructure silently hands the path back; the
 * passkey suite's 409 on a last credential catches it.
 */
const passkeyManagement = () => {
  const plugin = passkey({
    rpName: TOTP_ISSUER,
    // Pinned: with `origin` unset the plugin trusts the caller's `Origin`
    // header, and the assertion half (`passkey-assertion.ts`) pins it too.
    origin: PUBLIC_ORIGIN,
    rpID: RP_ID,
    schema: { passkey: { modelName: 'passkeys' } },
    // Only a client hint: the plugin verifies registration with
    // `requireUserVerification: false`. `afterVerification` is the gate.
    authenticatorSelection: { userVerification: 'required' },
    registration: {
      // The signed UV bit: the assertion path requires UV, so a non-UV
      // credential would be a factor that can never complete.
      afterVerification: ({ verification }) => {
        if (verification.registrationInfo?.userVerified !== true)
          throw authError(
            HTTP_STATUS.BAD_REQUEST,
            twoFactorMsg.passkeyNotUserVerifying
          );
      },
    },
  });
  const {
    deletePasskey: _deletePasskey,
    generatePasskeyAuthenticationOptions: _authenticationOptions,
    verifyPasskeyAuthentication: _authentication,
    ...endpoints
  } = plugin.endpoints;
  return { ...plugin, endpoints } satisfies BetterAuthPlugin;
};

export const twoFactorPlugins = [
  // Never conditional — see `twoFactorSignInGuard`.
  twoFactorSignInGuard(),
  ...(TWO_FACTOR_ENABLED
    ? [
        twoFactorAuth(),
        trustedDevice(),
        twoFactorEnrolment(),
        ...(TWO_FACTOR_OTP_AVAILABLE ? [twoFactorOtp()] : []),
        ...(isTwoFactorMethodEnabled('passkey')
          ? [passkeyManagement(), twoFactorPasskey()]
          : []),
      ]
    : []),
];
