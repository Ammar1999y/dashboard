/**
 * Passkey as a SECOND factor, which the passkey plugin does not offer.
 *
 * ⚠️ The plugin's `/passkey/verify-authentication` resolves a credential by
 * `credentialID` alone and calls `createSession(passkey.userId)` — a complete
 * unauthenticated sign-in endpoint. It and
 * `/passkey/generate-authenticate-options` must stay absent from
 * `BETTER_AUTH_ENDPOINTS`, unconditionally and with no flag.
 *
 * The assertion here is bound to the pending challenge twice, and neither half
 * is optional: `allowCredentials` is scoped to the challenge user (a browser
 * hint, not a guarantee), and the stored credential is looked up UNDER that user
 * so a mismatch cannot resolve at all.
 */
import type { BetterAuthPlugin } from 'better-auth';

import { withTransaction } from '@/db';
import { VERIFICATION_IDENTIFIER_MAX } from '@/db/limits';
import { createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { twoFactorPasskeyVerifySchema } from '@app/shared/validation/two-factor';

import { logSanitized } from '@/utils/log';

import { parseAuthBody } from '../context';
import { authError } from '../errors';
import { twoFactorMsg } from '../messages';
import {
  advancePasskeyCounter,
  passkeyOptions,
  verifyUserPasskey,
} from '../passkey-assertion';
import { envelopeResponse } from '../plugin-openapi';
import {
  expiresIn,
  replaceVerification,
  twoFactorWebauthnKey,
} from '../verifications';
import {
  challengeMissingError,
  completeTwoFactorChallenge,
  requireTwoFactorChallenge,
  spendChallengeAttempt,
} from './challenge';

const CHALLENGE_MAX_AGE_S = 300;

/**
 * Keyed by the 2FA challenge id rather than a cookie of its own, which is what
 * makes the ceremony inseparable from the sign-in it belongs to: one started
 * under one challenge cannot be completed under another.
 */
function ceremonyIdentifier(challengeId: string): string {
  return twoFactorWebauthnKey(challengeId).slice(
    0,
    VERIFICATION_IDENTIFIER_MAX
  );
}

export const twoFactorPasskey = () =>
  ({
    id: 'two-factor-passkey',
    endpoints: {
      twoFactorPasskeyOptions: createAuthEndpoint(
        '/two-factor/passkey/options',
        {
          method: 'POST',
          metadata: {
            openapi: envelopeResponse(
              'WebAuthn authentication options, scoped to the challenge user.',
              { type: 'object' }
            ),
          },
        },
        async (ctx) => {
          const challenge = await requireTwoFactorChallenge(ctx, {
            method: 'passkey',
          });
          const options = await passkeyOptions(challenge.user.id, () => {
            throw authError(
              HTTP_STATUS.BAD_REQUEST,
              twoFactorMsg.methodUnavailable
            );
          });

          // Replacing any previous ceremony for this challenge is deliberate:
          // only the newest options stay live.
          await withTransaction((tx) =>
            replaceVerification(
              tx,
              ceremonyIdentifier(challenge.challengeId),
              options.challenge,
              expiresIn(CHALLENGE_MAX_AGE_S)
            )
          );

          return ctx.json({ success: true, data: options });
        }
      ),

      twoFactorPasskeyVerify: createAuthEndpoint(
        '/two-factor/passkey/verify',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          metadata: {
            openapi: envelopeResponse(
              'The passkey assertion was verified and the sign-in completed.'
            ),
          },
        },
        async (ctx) => {
          const challenge = await requireTwoFactorChallenge(ctx, {
            method: 'passkey',
          });

          const { response } = parseAuthBody(
            ctx,
            twoFactorPasskeyVerifySchema,
            twoFactorMsg.invalidCode
          );

          const attempt = await spendChallengeAttempt(
            ctx,
            challenge.challengeId
          );
          if (!attempt.ok)
            throw authError(
              HTTP_STATUS.BAD_REQUEST,
              twoFactorMsg.tooManyAttempts
            );

          // The attempt is spent and NOT written back, so every exit below has
          // to settle it exactly once. `settled` is what makes the catch a
          // refund for everything that produced no verdict: a rejected
          // assertion, or one naming a credential this user does not hold,
          // charges on its own way out; a ceremony that was never started, a
          // malformed body, a database error or a counter write that throws
          // gives the attempt back instead of leaving the row absent.
          let settled = false;
          const chargeFailure = async () => {
            settled = true;
            await attempt.recordFailure();
          };

          try {
            const identifier = ceremonyIdentifier(challenge.challengeId);
            const stored =
              await ctx.context.internalAdapter.consumeVerificationValue(
                identifier
              );
            if (!stored || stored.expiresAt <= new Date())
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.invalidCode
              );

            let verification;
            try {
              verification = await verifyUserPasskey(
                challenge.user.id,
                response,
                stored.value
              );
            } catch (error) {
              await chargeFailure();
              logSanitized('error', {
                msg: 'twoFactor.passkey.verifyFailed',
                error,
              });
              throw authError(
                HTTP_STATUS.UNAUTHORIZED,
                twoFactorMsg.invalidCode
              );
            }

            // A concurrent assertion already carried the row to at least this
            // value. Logged because it is the only visible trace of two
            // simultaneous ceremonies on one credential, not because it failed.
            // A THROW here is still refunded: the assertion was proven, so the
            // attempt was not a guess and the challenge is still live.
            if (
              !(await advancePasskeyCounter(
                verification.credential.id,
                verification.newCounter
              ))
            )
              logSanitized('error', {
                msg: 'twoFactor.passkey.counterReconciled',
                passkeyId: verification.credential.id,
              });

            // The challenge is about to be consumed, so nothing after this may
            // re-arm its counter.
            settled = true;

            const completed = await completeTwoFactorChallenge(
              ctx,
              challenge,
              'passkey'
            );
            if (!completed) throw challengeMissingError();

            return ctx.json({
              success: true,
              message: twoFactorMsg.verifySuccess,
              data: { loggedIn: true },
            });
          } catch (error) {
            if (!settled) await attempt.restore();
            throw error;
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
