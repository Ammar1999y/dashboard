/**
 * ⚠️ Replaces the plugin's lifecycle endpoints: this deployment's invariants
 * (method intent, capability, backup-code acknowledgement, session rotation,
 * trust revocation) cannot be made atomic with the plugin's writes from a hook.
 * Every mutation takes the user lock first, in the canonical lock order.
 */
import type { AuthContext } from '../context';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { TwoFactorMethod } from '@app/shared/validation/enums';
import type { BetterAuthPlugin } from 'better-auth';
import type { SymmetricEncryptOptions } from 'better-auth/crypto';

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import {
  passkeys,
  twoFactorCredentials,
  twoFactorMethods,
  users,
  verifications,
} from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';
import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from 'better-auth/crypto';

import * as contract from '@app/shared/api/better-auth';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { otpMsg } from '@app/shared/messages/otp';
import { validID } from '@app/shared/utils';
import { optionId } from '@app/shared/validation/enums';
import {
  isTwoFactorMethodEnabled,
  ownedRowSchema,
  twoFactorBackupAcknowledgeSchema,
  twoFactorMethodOptionSchema,
  twoFactorTotpConfirmSchema,
} from '@app/shared/validation/two-factor';

import { generateUuidV7 } from '@/lib/id';

import { parseAuthBody } from '../context';
import { authError } from '../errors';
import { pluginEndpoint } from '../plugin-endpoint';
import { mintReauthGrant, requireReauthPassword } from '../reauth/grant';
import { resolveRequestSession } from '../session/request';
import { revokeTwoFactorState } from '../session/rotation';
import { lockUser } from '../user-eligibility';
import {
  expiresIn,
  replaceVerification,
  totpEnrolmentKey,
} from '../verifications';
import { encodeBackupCodes, generateBackupCodes } from './backup-codes';
import { challengeMissingError } from './challenge';
import { auditLifecycle, enableMethod } from './lifecycle';
import {
  clearTwoFactorEnrolment,
  enrolmentRows,
  listEnrolledMethods,
  matchesEnrolment,
  readEnrolmentState,
  removalStrandsTwoFactor,
  removeMethodIntent,
} from './methods';
import { sessionBodyOptions, sessionOptions } from './session-endpoint';
import { consumeTotpCode } from './totp-replay';
import { markTwoFactorProven } from './trusted-device';

/** The plugin's TOTP secret length; applies to new enrolments only. */
const TOTP_SECRET_LENGTH = 32;

/** Baked into every enrolled authenticator; changing it re-enrols every user. */
export const TOTP_ISSUER = 'Dashboard';

export const TOTP_ENROLMENT_MAX_AGE_S = 600;

// No authenticator holds it, but a code can still match, so
// `/two-factor/totp/confirm` also requires the pending `totpEnrolmentKey` row.
function placeholderTotpSecret(
  key: SymmetricEncryptOptions['key']
): Promise<string> {
  return symmetricEncrypt({
    key,
    data: generateRandomString(TOTP_SECRET_LENGTH),
  });
}

function methodNotFound() {
  return authError(HTTP_STATUS.NOT_FOUND, twoFactorMsg.methodUnavailable);
}

/** `method` gates the endpoint on the deployment serving it, before the session. */
async function requireSession(ctx: AuthContext, method?: TwoFactorMethod) {
  if (method && !isTwoFactorMethodEnabled(method)) throw methodNotFound();
  const session = await resolveRequestSession(ctx);
  if (!session) throw challengeMissingError();
  return session;
}

export const twoFactorEnrolment = () =>
  ({
    id: 'two-factor-enrolment',
    endpoints: {
      // `two_factor_enabled` is deliberately NOT set here: an abandoned setup
      // must leave the account as it was.
      startTotpEnrolment: pluginEndpoint(
        contract.startTotpEnrolment,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx, 'totp');
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          const [user] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!user) throw challengeMissingError();

          const secret = generateRandomString(TOTP_SECRET_LENGTH);
          const encrypted = await symmetricEncrypt({
            key: ctx.context.secretConfig,
            data: secret,
          });

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const [existing] = await tx
              .select({
                id: twoFactorCredentials.id,
                verified: twoFactorCredentials.verified,
              })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, userId))
              .limit(1);

            // A verified authenticator is never silently replaced.
            if (existing?.verified === true)
              throw authError(
                HTTP_STATUS.CONFLICT,
                twoFactorMsg.totpAlreadyEnrolled
              );

            if (existing)
              await tx
                .update(twoFactorCredentials)
                .set({ secret: encrypted, verified: false })
                .where(eq(twoFactorCredentials.id, existing.id));
            else
              await tx.insert(twoFactorCredentials).values({
                userId,
                secret: encrypted,
                // Not generated here: a set minted as a side effect would be
                // advertised unacknowledged.
                backupCodes: await encodeBackupCodes(
                  ctx.context.secretConfig,
                  []
                ),
                verified: false,
              });
            await replaceVerification(
              tx,
              totpEnrolmentKey(userId),
              userId,
              expiresIn(TOTP_ENROLMENT_MAX_AGE_S)
            );
            await auditLifecycle(tx, ctx, session, {
              totpEnrolmentStarted: true,
            });
          });

          return ctx.json({
            data: {
              totpURI: createOTP(secret).url(TOTP_ISSUER, user.email),
            },
          });
        }
      ),

      /** The ONLY writer that turns TOTP on. */
      confirmTotpEnrolment: pluginEndpoint(
        contract.confirmTotpEnrolment,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx, 'totp');

          const { code } = parseAuthBody(
            ctx,
            twoFactorTotpConfirmSchema,
            twoFactorMsg.invalidCode
          );

          // ⚠️ All under the user lock: `/two-factor/totp/start` rewrites this
          // row, so a secret verified before the lock may not be the one marked.
          await withTransaction(async (tx) => {
            await lockUser(tx, session.userId);

            const pendingStart = and(
              eq(verifications.identifier, totpEnrolmentKey(session.userId)),
              eq(verifications.value, session.userId)
            );
            const [pending] = await tx
              .select({ id: verifications.id })
              .from(verifications)
              .where(and(pendingStart, gt(verifications.expiresAt, new Date())))
              .limit(1);
            if (!pending)
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.totpEnrolmentExpired
              );

            const [credential] = await tx
              .select({
                id: twoFactorCredentials.id,
                secret: twoFactorCredentials.secret,
                verified: twoFactorCredentials.verified,
              })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, session.userId))
              .limit(1);
            if (!credential) throw methodNotFound();
            if (credential.verified)
              throw authError(
                HTTP_STATUS.CONFLICT,
                twoFactorMsg.totpAlreadyEnrolled
              );

            const secret = await symmetricDecrypt({
              key: ctx.context.secretConfig,
              data: credential.secret,
            }).catch(() => null);
            if (!secret) throw methodNotFound();

            // The sign-in verifier's window and reservation, so the enrolling
            // code cannot be replayed at the sign-in that follows.
            if (
              (await consumeTotpCode(session.userId, secret, code, {
                executor: tx,
              })) !== 'matched'
            )
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.invalidCode
              );

            // Cannot fail under the lock; the guard makes an edit that moves
            // work outside it fail loudly instead of activating an unproven secret.
            const activated = await tx
              .update(twoFactorCredentials)
              .set({ verified: true })
              .where(
                and(
                  eq(twoFactorCredentials.id, credential.id),
                  eq(twoFactorCredentials.secret, credential.secret),
                  eq(twoFactorCredentials.verified, false)
                )
              )
              .returning({ id: twoFactorCredentials.id });
            if (activated.length === 0)
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.invalidCode
              );

            await tx.delete(verifications).where(pendingStart);
            await enableMethod(tx, ctx, session, 'totp');
            // A code was just proven on this session, so device trust is
            // redeemable — trust binds to a proof, not to holding a session.
            await markTwoFactorProven(tx, session.sessionId);
          });

          return ctx.json({
            message: twoFactorMsg.enabled,
            data: { method: 'totp' },
          });
        }
      ),

      // The new set id unbinds the old acknowledgement, so `backup_code` is not
      // offered until the new set is acknowledged.
      generateBackupCodes: pluginEndpoint(
        contract.generateBackupCodes,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx, 'backup_code');
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          const codes = generateBackupCodes();
          const encoded = await encodeBackupCodes(
            ctx.context.secretConfig,
            codes
          );
          const setId = generateUuidV7();

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const [existing] = await tx
              .select({ id: twoFactorCredentials.id })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, userId))
              .limit(1);

            if (existing)
              await tx
                .update(twoFactorCredentials)
                .set({
                  backupCodes: encoded,
                  backupCodesSetId: setId,
                  backupCodesAcknowledgedSetId: null,
                  backupCodesAcknowledgedAt: null,
                  backupCodesRemaining: codes.length,
                })
                .where(eq(twoFactorCredentials.id, existing.id));
            else
              // A backup-code-only deployment has no TOTP secret to hang this
              // off, and `secret` is NOT NULL.
              await tx.insert(twoFactorCredentials).values({
                userId,
                secret: await placeholderTotpSecret(ctx.context.secretConfig),
                backupCodes: encoded,
                verified: false,
                backupCodesSetId: setId,
                backupCodesRemaining: codes.length,
              });

            await auditLifecycle(tx, ctx, session, {
              backupCodesRegenerated: true,
              backupCodesCount: codes.length,
              backupCodesSetId: setId,
            });

            // The intent row is deliberately kept; `backupCodesReady` answers
            // false until the new set is acknowledged.
          });

          return ctx.json({
            data: { backupCodes: codes, setId },
          });
        }
      ),

      acknowledgeBackupCodes: pluginEndpoint(
        contract.acknowledgeBackupCodes,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx, 'backup_code');

          // Before the proof, so a malformed body cannot buy an Argon2id run.
          const { setId } = parseAuthBody(
            ctx,
            twoFactorBackupAcknowledgeSchema,
            otpMsg.invalidInput
          );

          // It flips the flag and revokes other sessions, so it needs the same
          // proof as every other transition that does.
          await requireReauthPassword(ctx, session.userId);

          const acknowledged = await withTransaction(async (tx) => {
            await lockUser(tx, session.userId);
            const [credential] = await tx
              .select({
                id: twoFactorCredentials.id,
                setId: twoFactorCredentials.backupCodesSetId,
                remaining: twoFactorCredentials.backupCodesRemaining,
              })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, session.userId))
              .limit(1);
            if (!credential?.setId || credential.remaining === 0) return false;
            // The set the caller saw, not whichever is current.
            if (credential.setId !== setId) return 'stale';

            await tx
              .update(twoFactorCredentials)
              .set({
                backupCodesAcknowledgedAt: new Date(),
                backupCodesAcknowledgedSetId: credential.setId,
              })
              .where(eq(twoFactorCredentials.id, credential.id));
            await enableMethod(tx, ctx, session, 'backup_code', {
              backupCodesSetId: credential.setId,
            });
            return true;
          });

          if (acknowledged === 'stale')
            throw authError(HTTP_STATUS.CONFLICT, twoFactorMsg.staleBackupSet);
          if (!acknowledged) throw methodNotFound();
          return ctx.json({ message: twoFactorMsg.enabled });
        }
      ),

      listTwoFactorMethods: pluginEndpoint(
        contract.listTwoFactorMethods,
        sessionOptions(),
        async (ctx) => {
          const userId = validID(ctx.context.session?.user.id);
          if (!userId) throw challengeMissingError();
          return ctx.json({
            data: { methods: await listEnrolledMethods(userId) },
          });
        }
      ),

      /**
       * ⚠️ The enrolled set is read under the user lock in the deleting
       * transaction; otherwise two concurrent removals both see two methods and
       * leave 2FA on with nothing. A removal leaving nothing a challenge offers
       * is refused too — see `removalStrandsTwoFactor`.
       */
      disableTwoFactorMethod: pluginEndpoint(
        contract.disableTwoFactorMethod,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          const { method, contactKind } = parseAuthBody(
            ctx,
            twoFactorMethodOptionSchema,
            twoFactorMsg.methodUnavailable
          );

          const removed = await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const enrolled = await listEnrolledMethods(userId, tx);
            // `contactKind` is required for `otp` by the schema, so this names
            // exactly one row rather than whichever sorted first.
            const target = enrolled.find((entry) =>
              matchesEnrolment(entry, method, contactKind)
            );
            if (!target) throw methodNotFound();
            if (enrolled.length === 1)
              throw authError(HTTP_STATUS.CONFLICT, twoFactorMsg.lastMethod);
            const state = await readEnrolmentState(userId, tx);
            if (removalStrandsTwoFactor(state, method, target.contactKind))
              throw authError(HTTP_STATUS.CONFLICT, twoFactorMsg.lastMethod);

            const removedOption = optionId(method, target.contactKind);
            await removeMethodIntent(tx, userId, method, target.contactKind);
            await clearCapabilityFor(
              tx,
              userId,
              method,
              ctx.context.secretConfig
            );
            await auditLifecycle(tx, ctx, session, {
              twoFactorMethodRemoved: removedOption,
              remaining: enrolled.length - 1,
            });
            // Trust granted against the removed factor would bypass it.
            await revokeTwoFactorState(tx, userId);
            return removedOption;
          });

          return ctx.json({
            message: twoFactorMsg.disabled,
            data: { removedMethod: removed },
          });
        }
      ),

      /** The method a challenge routes to first, within what is enrolled. */
      setDefaultTwoFactorMethod: pluginEndpoint(
        contract.setDefaultTwoFactorMethod,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          const { method, contactKind } = parseAuthBody(
            ctx,
            twoFactorMethodOptionSchema,
            twoFactorMsg.methodUnavailable
          );

          const defaultMethod = await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const enrolled = await listEnrolledMethods(userId, tx);
            // Only a reorder: a default the user has not enrolled is never offered.
            const target = enrolled.find((entry) =>
              matchesEnrolment(entry, method, contactKind)
            );
            if (!target) throw methodNotFound();

            await tx
              .update(twoFactorMethods)
              .set({ isDefault: false })
              .where(eq(twoFactorMethods.userId, userId));
            await tx
              .update(twoFactorMethods)
              .set({ isDefault: true })
              .where(enrolmentRows(userId, method, target.contactKind));
            const chosen = optionId(method, target.contactKind);
            await auditLifecycle(tx, ctx, session, {
              twoFactorDefaultChanged: chosen,
            });
            return chosen;
          });

          return ctx.json({ data: { defaultMethod } });
        }
      ),

      /**
       * Replaces the plugin's endpoint, which deletes only the row and leaves
       * intent, flag and trusted devices behind. The password proof arrives as
       * the enrolment grant, consumed in `path-policy.ts`.
       */
      deletePasskey: pluginEndpoint(
        contract.deletePasskey,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx, 'passkey');
          const { userId } = session;

          const { id: passkeyId } = parseAuthBody(
            ctx,
            ownedRowSchema,
            twoFactorMsg.methodUnavailable
          );

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            // Another user's id and a missing one answer identically.
            const owned = await tx
              .select({ id: passkeys.id })
              .from(passkeys)
              .where(eq(passkeys.userId, userId));
            if (!owned.some((row) => row.id === passkeyId))
              throw methodNotFound();

            const enrolled = await listEnrolledMethods(userId, tx);
            const isFactor = enrolled.some(
              (entry) => entry.method === 'passkey'
            );
            const removesMethod = isFactor && owned.length === 1;
            if (
              removesMethod &&
              (enrolled.length === 1 ||
                removalStrandsTwoFactor(
                  await readEnrolmentState(userId, tx),
                  'passkey',
                  null
                ))
            )
              throw authError(HTTP_STATUS.CONFLICT, twoFactorMsg.lastMethod);

            await tx.delete(passkeys).where(eq(passkeys.id, passkeyId));

            if (removesMethod) {
              await removeMethodIntent(tx, userId, 'passkey');
              await auditLifecycle(tx, ctx, session, {
                passkeyDeleted: passkeyId,
                twoFactorMethodRemoved: 'passkey',
                remaining: enrolled.length - 1,
              });
              await revokeTwoFactorState(tx, userId);
              return;
            }
            await auditLifecycle(tx, ctx, session, {
              passkeyDeleted: passkeyId,
              passkeysRemaining: owned.length - 1,
            });
          });

          return ctx.json({ data: { deleted: true } });
        }
      ),

      // Replaces the plugin's `/two-factor/disable`, which leaves intent rows,
      // trusted devices and live challenges behind.
      disableTwoFactor: pluginEndpoint(
        contract.disableTwoFactor,
        sessionBodyOptions(),
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            // Passkeys are deliberately kept: with no intent row they are not a
            // factor, and turning 2FA off must not destroy hardware enrolments.
            await clearTwoFactorEnrolment(tx, userId, {
              deletePasskeys: false,
            });
            await revokeTwoFactorState(tx, userId);
            await auditLifecycle(tx, ctx, session, {
              twoFactorEnabled: false,
              twoFactorDisabled: true,
            });
          });

          return ctx.json({ message: twoFactorMsg.disabled });
        }
      ),

      // The library's ceremony bodies cannot carry a password, so it is proven
      // here and spent by `/passkey/verify-registration` and `/passkey/delete-passkey`.
      passkeyEnrolmentGrant: pluginEndpoint(
        contract.passkeyEnrolmentGrant,
        sessionBodyOptions(),
        async (ctx) => {
          const { userId } = await requireSession(ctx, 'passkey');
          await requireReauthPassword(ctx, userId);
          return ctx.json({
            data: {
              grant: await mintReauthGrant(ctx, {
                userId,
                purpose: 'two_factor_enrolment',
              }),
            },
          });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;

/**
 * Otherwise an intent write alone would revive the method with no proof.
 * `passkey` credentials are deliberately kept.
 *
 * ⚠️ TOTP loses its secret, not only `verified`: `/two-factor/totp/confirm`
 * takes no password, so a leftover secret is re-enabled by the old authenticator.
 */
async function clearCapabilityFor(
  tx: Tx,
  userId: EntityID,
  method: TwoFactorMethod,
  key: SymmetricEncryptOptions['key']
): Promise<void> {
  if (method === 'totp')
    await tx
      .update(twoFactorCredentials)
      .set({ secret: await placeholderTotpSecret(key), verified: false })
      .where(eq(twoFactorCredentials.userId, userId));
  else if (method === 'backup_code')
    await tx
      .update(twoFactorCredentials)
      .set({
        backupCodesAcknowledgedSetId: null,
        backupCodesAcknowledgedAt: null,
      })
      .where(eq(twoFactorCredentials.userId, userId));
}
