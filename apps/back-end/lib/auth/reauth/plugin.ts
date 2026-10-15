import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { passkeys, verifications } from '@/db/schema';
import * as z from 'zod';

import { MSG_INVALID_CREDENTIALS } from '@app/shared/messages/auth';
import { reauthPasskeySchema } from '@app/shared/validation/reauth';
import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { auditLog } from '@/lib/audit';

import { logSanitized } from '@/utils/log';

import { authAuditMeta } from '../context';
import { asAuthError, authenticationDenied } from '../errors';
import {
  advancePasskeyCounter,
  passkeyOptions,
  verifyUserPasskey,
} from '../passkey-assertion';
import { pluginEndpoint } from '../plugin-endpoint';
import { authenticationStartedAt } from '../session/authentication-time';
import { lockSessionOwner } from '../session/live';
import { lockUser } from '../user-eligibility';
import { expiresIn, reauthPasskeyKey } from '../verifications';
import { availableReauthMethods } from './methods';
import { enforceReauthAttemptLimit, requireReauthSession } from './session';
import { mintAdminReauth } from './window';

const CEREMONY_MAX_AGE_S = 300;

const ceremonySchema = z.object({
  challenge: z.string(),
  startedAt: z.number().int().safe(),
});

export const reauthentication = () =>
  ({
    id: 'reauthentication',
    endpoints: {
      reauthMethods: pluginEndpoint(
        '/reauth/methods',
        { method: 'GET' },
        async (ctx) => {
          const { userId } = await requireReauthSession(ctx);
          return ctx.json({
            data: { methods: await availableReauthMethods(userId) },
          });
        }
      ),
      ...(isTwoFactorMethodEnabled('passkey') && {
        reauthPasskeyOptions: pluginEndpoint(
          '/reauth/passkey/options',
          { method: 'POST' },
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
              return ctx.json({ data: options });
            } catch (error) {
              throw asAuthError(error, MSG_INVALID_CREDENTIALS);
            }
          }
        ),
        reauthPasskeyVerify: pluginEndpoint(
          '/reauth/passkey/verify',
          { method: 'POST', body: reauthPasskeySchema },
          async (ctx) => {
            try {
              const { userId, sessionId, userEmail } =
                await requireReauthSession(ctx);
              await enforceReauthAttemptLimit(userId);
              const [stored] = await db
                .select({ id: verifications.id, value: verifications.value })
                .from(verifications)
                .where(
                  and(
                    eq(verifications.identifier, reauthPasskeyKey(sessionId)),
                    gt(verifications.expiresAt, new Date())
                  )
                )
                .limit(1);
              if (!stored) throw authenticationDenied();
              const ceremony = ceremonySchema.parse(JSON.parse(stored.value));
              const verified = await verifyUserPasskey(
                userId,
                ctx.body.response,
                ceremony.challenge
              );
              const grant = await withTransaction(async (tx) => {
                await lockUser(tx, userId);
                // Spent with the grant it buys: an attempt that rolls back
                // leaves the ceremony for the retry its 503 invites. Expiry is
                // read again here, since the lock may have outlasted it.
                const [spent] = await tx
                  .delete(verifications)
                  .where(
                    and(
                      eq(verifications.id, stored.id),
                      gt(verifications.expiresAt, new Date())
                    )
                  )
                  .returning({ id: verifications.id });
                if (!spent) throw authenticationDenied();
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
              return ctx.json({ data: grant });
            } catch (error) {
              throw asAuthError(error, MSG_INVALID_CREDENTIALS);
            }
          }
        ),
      }),
    },
  }) satisfies BetterAuthPlugin;
