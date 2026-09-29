import type { BetterAuthPlugin } from 'better-auth';

import { and, eq } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { passkeys, verifications } from '@/db/schema';
import { createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';

import { CustomError } from '@app/shared/error-class';
import {
  REAUTH_METHODS,
  reauthPasskeySchema,
} from '@app/shared/validation/reauth';
import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { auditLog } from '@/lib/audit';

import { logSanitized } from '@/utils/log';

import { authAuditMeta } from '../context';
import { asAuthError, authenticationDenied, toAuthApiError } from '../errors';
import {
  advancePasskeyCounter,
  passkeyOptions,
  verifyUserPasskey,
} from '../passkey-assertion';
import { envelopeResponse } from '../plugin-openapi';
import { authenticationStartedAt } from '../session/authentication-time';
import { lockSessionOwner } from '../session/live';
import { lockUser } from '../user-eligibility';
import { expiresIn, reauthPasskeyKey } from '../verifications';
import { availableReauthMethods } from './methods';
import { enforceReauthAttemptLimit, requireReauthSession } from './session';
import { mintAdminReauth } from './window';

const CEREMONY_MAX_AGE_S = 300;

const MSG_REAUTH_FAILED = 'Reauthentication failed.';

const ceremonySchema = z.object({
  challenge: z.string(),
  startedAt: z.number().int().safe(),
});

export const reauthentication = () =>
  ({
    id: 'reauthentication',
    endpoints: {
      reauthMethods: createAuthEndpoint(
        '/reauth/methods',
        {
          method: 'GET',
          metadata: {
            openapi: envelopeResponse(
              'Methods available for this authenticated account.',
              {
                type: 'object',
                properties: {
                  methods: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [...REAUTH_METHODS],
                    },
                  },
                },
                required: ['methods'],
              }
            ),
          },
        },
        async (ctx) => {
          const { userId } = await requireReauthSession(ctx);
          return ctx.json({
            success: true,
            data: { methods: await availableReauthMethods(userId) },
          });
        }
      ),
      ...(isTwoFactorMethodEnabled('passkey') && {
        reauthPasskeyOptions: createAuthEndpoint(
          '/reauth/passkey/options',
          {
            method: 'POST',
            metadata: {
              openapi: envelopeResponse(
                'User-verifying WebAuthn options bound to this session.',
                { type: 'object' }
              ),
            },
          },
          async (ctx) => {
            try {
              const { userId, sessionId } = await requireReauthSession(ctx);
              await enforceReauthAttemptLimit(userId);
              const options = await passkeyOptions(userId);
              await withTransaction(async (tx) => {
                if (!(await lockSessionOwner(tx, userId, sessionId)))
                  throw authenticationDenied();
                await tx
                  .delete(verifications)
                  .where(
                    eq(verifications.identifier, reauthPasskeyKey(sessionId))
                  );
                await tx.insert(verifications).values({
                  identifier: reauthPasskeyKey(sessionId),
                  value: JSON.stringify({
                    challenge: options.challenge,
                    startedAt: await authenticationStartedAt(tx),
                  }),
                  expiresAt: expiresIn(CEREMONY_MAX_AGE_S),
                });
              });
              return ctx.json({ success: true, data: options });
            } catch (error) {
              throw asAuthError(error, MSG_REAUTH_FAILED);
            }
          }
        ),
        reauthPasskeyVerify: createAuthEndpoint(
          '/reauth/passkey/verify',
          {
            method: 'POST',
            body: reauthPasskeySchema,
            metadata: {
              openapi: envelopeResponse('Reauthentication granted.', {
                type: 'object',
                properties: { expiresIn: { type: 'integer' } },
                required: ['expiresIn'],
              }),
            },
          },
          async (ctx) => {
            try {
              const { userId, sessionId, userEmail } =
                await requireReauthSession(ctx);
              await enforceReauthAttemptLimit(userId);
              const stored =
                await ctx.context.internalAdapter.consumeVerificationValue(
                  reauthPasskeyKey(sessionId)
                );
              if (!stored) throw authenticationDenied();
              const ceremony = ceremonySchema.parse(JSON.parse(stored.value));
              const verified = await verifyUserPasskey(
                userId,
                ctx.body.response,
                ceremony.challenge
              );
              const grant = await withTransaction(async (tx) => {
                await lockUser(tx, userId);
                const [credential] = await tx
                  .select()
                  .from(passkeys)
                  .where(
                    and(
                      eq(passkeys.id, verified.credential.id),
                      eq(passkeys.userId, userId)
                    )
                  )
                  .for('update');
                if (
                  !credential ||
                  credential.publicKey !== verified.credential.publicKey
                )
                  throw authenticationDenied();
                if (
                  !(await advancePasskeyCounter(
                    credential.id,
                    verified.newCounter,
                    tx
                  ))
                )
                  logSanitized('error', {
                    msg: 'reauth.passkey.counterReconciled',
                    passkeyId: credential.id,
                  });
                await auditLog(tx, {
                  userId,
                  userEmail,
                  action: 'UPDATE',
                  tableName: 'sessions',
                  recordId: sessionId,
                  oldData: {},
                  newData: { reauthenticated: true, method: 'passkey' },
                  meta: authAuditMeta(ctx),
                });
                return mintAdminReauth(userId, sessionId, {
                  method: 'passkey',
                  executor: tx,
                  startedAt: ceremony.startedAt,
                });
              });
              return ctx.json({ success: true, data: grant });
            } catch (error) {
              // Unlike the options endpoint: any other failure is a denial.
              if (error instanceof CustomError)
                throw toAuthApiError(error, MSG_REAUTH_FAILED);
              throw authenticationDenied();
            }
          }
        ),
      }),
    },
  }) satisfies BetterAuthPlugin;
