/**
 * ⚠️ The plugin's `/passkey/verify-authentication` is an unauthenticated
 * sign-in (credential id alone); it and `/passkey/generate-authenticate-options`
 * must stay out of `BETTER_AUTH_ENDPOINTS`, unconditionally.
 *
 * `allowCredentials` is only a browser hint; the credential lookup under the
 * challenge user is the binding.
 */
import type { BetterAuthPlugin } from 'better-auth';

import { withTransaction } from '@/db';
import { VERIFICATION_IDENTIFIER_MAX } from '@/db/limits';
import { isAPIError } from 'better-auth/api';
import * as z from 'zod';

import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { twoFactorPasskeyVerifySchema } from '@app/shared/validation/two-factor';

import { logSanitized } from '@/utils/log';

import { parseAuthBody } from '../context';
import { authError } from '../errors';
import {
  advancePasskeyCounter,
  passkeyOptions,
  verifyUserPasskey,
} from '../passkey-assertion';
import { pluginEndpoint } from '../plugin-endpoint';
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

// Keyed by the challenge id, so a ceremony cannot complete under another challenge.
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
      twoFactorPasskeyOptions: pluginEndpoint(
        '/two-factor/passkey/options',
        { method: 'POST' },
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

      twoFactorPasskeyVerify: pluginEndpoint(
        '/two-factor/passkey/verify',
        { method: 'POST', body: z.record(z.string(), z.unknown()) },
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

          // ⚠️ The spent attempt is not written back, so every exit must settle
          // it exactly once: a rejected assertion charges, anything that
          // produced no verdict is refunded by the catch.
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
              // A denial is a guess; a database fault is no verdict, so the
              // outer catch refunds it and the boundary answers it.
              if (!isAPIError(error)) throw error;
              await chargeFailure();
              throw authError(
                HTTP_STATUS.UNAUTHORIZED,
                twoFactorMsg.invalidCode
              );
            }

            // `false`: a concurrent assertion got there first. Logged as the only
            // trace of it, not as a failure.
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

            // The challenge is about to be consumed; nothing may re-arm its counter.
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
