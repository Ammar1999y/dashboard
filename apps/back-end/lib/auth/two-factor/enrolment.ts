/**
 * The second factor's own lifecycle — enable, confirm, add, remove, disable —
 * owned end to end rather than compensated after the library's.
 *
 * ⚠️ Why these are not the plugin's endpoints. Every invariant this deployment
 * adds (method intent, capability, backup-code acknowledgement, session
 * rotation, trust revocation) lives OUTSIDE the transitions the plugin performs,
 * and no hook after the fact makes them atomic with it. The plugin's
 * `/two-factor/enable` can also only produce TOTP here, which would leave
 * backup-code-only and passkey-only configurations no route to a first enable.
 *
 * So `/two-factor/enable` is not served, and `/two-factor/disable` and
 * `/two-factor/generate-backup-codes` are these. The plugin's `verify-totp` and
 * `verify-backup-code` stay, in SIGN-IN mode only: they are verifiers, not
 * transitions.
 *
 * Every mutation here is one transaction over `users`, `two_factor_credentials`
 * and `two_factor_methods`, taken in the canonical lock order.
 */
import type { AuthContext } from '../context';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { TwoFactorMethod } from '@app/shared/validation/enums';
import type { BetterAuthPlugin } from 'better-auth';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import {
  passkeys,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';
import { createAuthEndpoint } from 'better-auth/api';
import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from 'better-auth/crypto';

import { HTTP_STATUS } from '@app/shared/api-messages';
import { validID } from '@app/shared/utils';
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
import { otpMsg, twoFactorMsg } from '../messages';
import { mintReauthGrant, requireReauthPassword } from '../reauth/grant';
import { resolveRequestSession } from '../session/request';
import { revokeTwoFactorState } from '../session/rotation';
import { lockUser } from '../user-eligibility';
import { encodeBackupCodes, generateBackupCodes } from './backup-codes';
import { challengeMissingError } from './challenge';
import { auditLifecycle, enableMethod } from './lifecycle';
import {
  clearTwoFactorEnrolment,
  enrolmentRows,
  listEnrolledMethods,
  matchesEnrolment,
  optionId,
  readEnrolmentState,
  removalStrandsTwoFactor,
  removeMethodIntent,
} from './methods';
import { sessionGetOptions, sessionPostOptions } from './session-endpoint';
import { consumeTotpCode } from './totp-replay';
import { markTwoFactorProven } from './trusted-device';

/** The plugin's TOTP secret length. Changing it re-enrols every authenticator. */
const TOTP_SECRET_LENGTH = 32;

/**
 * Baked into every enrolled authenticator, so changing it later means
 * re-enrolling every user.
 */
export const TOTP_ISSUER = 'Dashboard';

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
      /**
       * Step one of TOTP enrolment: a secret, and nothing else.
       * `two_factor_enabled` is deliberately NOT set here: an abandoned setup
       * must leave the account exactly as it was.
       */
      startTotpEnrolment: createAuthEndpoint(
        '/two-factor/totp/start',
        sessionPostOptions('A TOTP secret to enrol.', {
          type: 'object',
          properties: { totpURI: { type: 'string' } },
          required: ['totpURI'],
        }),
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
                // Not generated here: backup codes are their own method with
                // their own acknowledgement, and a set minted as a side effect
                // would be advertised unacknowledged.
                backupCodes: await encodeBackupCodes(
                  ctx.context.secretConfig,
                  []
                ),
                verified: false,
              });
            await auditLifecycle(tx, ctx, session, {
              totpEnrolmentStarted: true,
            });
          });

          return ctx.json({
            success: true,
            data: {
              totpURI: createOTP(secret).url(TOTP_ISSUER, user.email),
            },
          });
        }
      ),

      /**
       * Step two, and the ONLY writer that turns TOTP on. One transaction: the
       * credential becomes verified, the intent row appears, the flag flips and
       * the other sessions go.
       */
      confirmTotpEnrolment: createAuthEndpoint(
        '/two-factor/totp/confirm',
        sessionPostOptions('TOTP is enrolled and enabled.'),
        async (ctx) => {
          const session = await requireSession(ctx, 'totp');

          const { code } = parseAuthBody(
            ctx,
            twoFactorTotpConfirmSchema,
            twoFactorMsg.invalidCode
          );

          // Read, decrypt, verify and activate all UNDER THE USER LOCK, and
          // guard the activation on the exact secret. `/two-factor/totp/start`
          // writes into this row, so a secret verified before the lock can be a
          // different secret by the time it is marked — TOTP enabled against
          // something no authenticator holds. `/two-factor/methods/disable` is
          // the mirror case.
          await withTransaction(async (tx) => {
            await lockUser(tx, session.userId);

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

            // The same one-period tolerance the plugin's verifier allows, so a
            // clock a few seconds out does not fail enrolment and then work at
            // every later sign-in — and the same reservation, so the code that
            // completes enrolment cannot then be replayed at the sign-in that
            // follows it seconds later.
            if (
              (await consumeTotpCode(session.userId, secret, code, {
                executor: tx,
              })) !== 'matched'
            )
              throw authError(
                HTTP_STATUS.BAD_REQUEST,
                twoFactorMsg.invalidCode
              );

            // Guarded on the exact secret that was just proven, and on the row
            // still being unverified. Under the lock this cannot fail; it is
            // here so that a future edit moving work back outside the lock
            // fails loudly instead of activating an unproven credential.
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

            // On confirmation, not on setup: an abandoned enrolment logs nobody
            // out.
            await enableMethod(tx, ctx, session, 'totp');
          });

          // A TOTP code WAS just proven on this session, so "remember this
          // device" is redeemable from here — the same rule as a sign-in
          // completion, and the reason trust is bound to a proof rather than to
          // holding a session.
          await markTwoFactorProven(ctx, session.sessionId);

          return ctx.json({
            success: true,
            message: twoFactorMsg.enabled,
            data: { method: 'totp' },
          });
        }
      ),

      /**
       * A new set of backup codes, which INVALIDATES the previous one.
       *
       * The new set id is what unbinds the old acknowledgement: until the user
       * confirms the new set, `backup_code` stops being offered, so one
       * acknowledgement cannot advertise whatever set exists later.
       */
      generateBackupCodes: createAuthEndpoint(
        '/two-factor/generate-backup-codes',
        sessionPostOptions(
          'A fresh set of backup codes. `setId` NAMES this set and must be sent back to /two-factor/backup-codes/acknowledge.',
          {
            type: 'object',
            properties: {
              backupCodes: { type: 'array', items: { type: 'string' } },
              setId: { type: 'string', format: 'uuid' },
            },
            required: ['backupCodes', 'setId'],
          }
        ),
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
              // off, and `secret` is NOT NULL — so the row carries an unverified
              // placeholder. `verified` stays false, so it is never a factor.
              await tx.insert(twoFactorCredentials).values({
                userId,
                secret: await symmetricEncrypt({
                  key: ctx.context.secretConfig,
                  data: generateRandomString(TOTP_SECRET_LENGTH),
                }),
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

            // The intent row is deliberately left alone: the user's choice of
            // method survives a regeneration, and `backupCodesReady` already
            // answers false until the new set is acknowledged.
          });

          // The id travels WITH the codes, because it is the only thing that
          // identifies which ten strings the user is about to write down.
          return ctx.json({
            success: true,
            data: { backupCodes: codes, setId },
          });
        }
      ),

      /**
       * Binds the acknowledgement to the set that exists NOW, and is the writer
       * that turns backup codes into an offered method.
       */
      acknowledgeBackupCodes: createAuthEndpoint(
        '/two-factor/backup-codes/acknowledge',
        sessionPostOptions(
          'The backup codes were acknowledged. `setId` must name the set the caller was shown; a different current set answers 409.'
        ),
        async (ctx) => {
          const session = await requireSession(ctx, 'backup_code');

          // Before the proof, not after: `requireReauthPassword` is an Argon2id
          // verification, and a malformed body must not be able to buy one.
          const { setId } = parseAuthBody(
            ctx,
            twoFactorBackupAcknowledgeSchema,
            otpMsg.invalidInput
          );

          // It flips the flag and revokes the caller's other sessions, so it
          // takes the proof every other transition that does either takes: a
          // hijacked session must not be able to turn the feature on and sign
          // the owner out of every device with one unauthenticated call.
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
            // The set the caller SAW, read under the same lock that writes the
            // acknowledgement: acknowledging whichever set is current would
            // enable the method for codes the user never saw.
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
          return ctx.json({ success: true, message: twoFactorMsg.enabled });
        }
      ),

      listTwoFactorMethods: createAuthEndpoint(
        '/two-factor/methods',
        sessionGetOptions('The caller’s enrolled methods.', {
          type: 'object',
          properties: {
            methods: { type: 'array', items: { type: 'object' } },
          },
          required: ['methods'],
        }),
        async (ctx) => {
          const userId = validID(ctx.context.session?.user.id);
          if (!userId) throw challengeMissingError();
          return ctx.json({
            success: true,
            data: { methods: await listEnrolledMethods(userId) },
          });
        }
      ),

      /**
       * Removes ONE enrolment.
       *
       * ⚠️ The enrolled set is read INSIDE the transaction that deletes, under
       * the user lock: read through the pool, two concurrent removals both see
       * two methods and both succeed, leaving an account 2FA-on with nothing.
       *
       * Two refusals. The sole intent row cannot be removed at all — "disable"
       * is the route for that. And a removal that would leave nothing a
       * challenge OFFERS is refused even when other rows exist, because a row
       * whose channel, contact or backup set is gone is not a factor; see
       * `removalStrandsTwoFactor`.
       */
      disableTwoFactorMethod: createAuthEndpoint(
        '/two-factor/methods/disable',
        sessionPostOptions('The method was removed.', {
          type: 'object',
          properties: {
            removedMethod: {
              type: 'string',
              description:
                'The option that is gone, `otp:email` / `otp:phone` / `totp` / `backup_code` / `passkey`.',
            },
          },
          required: ['removedMethod'],
        }),
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
            // Before the read, so a concurrent removal cannot decide "not the
            // last method" against a stale list.
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
            await clearCapabilityFor(tx, userId, method);
            await auditLifecycle(tx, ctx, session, {
              twoFactorMethodRemoved: removedOption,
              remaining: enrolled.length - 1,
            });
            // Removing a factor keeps the caller's sessions and drops every
            // standing skip of it: a trust row granted against the factor being
            // removed is a bypass of a factor that no longer exists.
            await revokeTwoFactorState(tx, userId);
            return removedOption;
          });

          // The option is named back: the caller sent a method and a contact
          // kind, and a bare success cannot show WHICH possession is gone.
          return ctx.json({
            success: true,
            message: twoFactorMsg.disabled,
            data: { removedMethod: removed },
          });
        }
      ),

      /** The method a challenge routes to first, within what is enrolled. */
      setDefaultTwoFactorMethod: createAuthEndpoint(
        '/two-factor/methods/default',
        sessionPostOptions('The default method was set.'),
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
            // Only ever a REORDER within the issued set: naming something the
            // user has not enrolled would produce a default that is never
            // offered, which is the empty-set branch by another route.
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

          return ctx.json({ success: true, data: { defaultMethod } });
        }
      ),

      /**
       * Deletes ONE credential, and with the last one the `passkey` method.
       *
       * Served here rather than by the passkey plugin because a credential can
       * be a second factor: the plugin's endpoint deletes the row and nothing
       * else, leaving the intent row, the flag and every trusted device — a
       * locked-out account with a standing skip of the factor it just lost.
       * The last-method rule and the trust revocation are the ones
       * `/two-factor/methods/disable` applies; the password proof arrives as
       * the enrolment grant, consumed in `lib/auth/path-policy.ts`.
       */
      deletePasskey: createAuthEndpoint(
        '/passkey/delete-passkey',
        sessionPostOptions('The passkey was deleted.', {
          type: 'object',
          properties: { deleted: { type: 'boolean' } },
          required: ['deleted'],
        }),
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
            // Ownership is in the WHERE, so another user's id and a missing one
            // answer identically.
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

          return ctx.json({ success: true, data: { deleted: true } });
        }
      ),

      /**
       * Turns the whole feature off for the caller.
       *
       * Replaces the plugin's `/two-factor/disable`, which touches the flag, the
       * credential row, the caller's session and its own trust cookie, and
       * leaves intent rows, this deployment's trusted devices and any live
       * challenge behind.
       */
      disableTwoFactor: createAuthEndpoint(
        '/two-factor/disable',
        sessionPostOptions('Two-factor authentication is off.'),
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            // Registered passkeys are deliberately KEPT: they are named
            // credentials the user manages at `/passkey/*`, and with no intent
            // row none of them is a second factor. Deleting them here would
            // make "turn 2FA off" quietly destroy hardware enrolments.
            await clearTwoFactorEnrolment(tx, userId, {
              deletePasskeys: false,
            });
            await revokeTwoFactorState(tx, userId);
            await auditLifecycle(tx, ctx, session, {
              twoFactorEnabled: false,
              twoFactorDisabled: true,
            });
          });

          return ctx.json({ success: true, message: twoFactorMsg.disabled });
        }
      ),

      /**
       * The re-authentication in front of a WebAuthn ceremony.
       *
       * The ceremony endpoints are the library's, take the library's bodies and
       * span two requests, so the password cannot ride on them. It is proven
       * here once and spent by `/passkey/verify-registration` and
       * `/passkey/delete-passkey` — the two that add and remove a factor.
       */
      passkeyEnrolmentGrant: createAuthEndpoint(
        '/two-factor/passkey/grant',
        sessionPostOptions('A single-use enrolment grant.', {
          type: 'object',
          properties: { grant: { type: 'string' } },
          required: ['grant'],
        }),
        async (ctx) => {
          const { userId } = await requireSession(ctx, 'passkey');
          await requireReauthPassword(ctx, userId);
          return ctx.json({
            success: true,
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
 * Removing a method removes what made it usable, or the method could be re-added
 * by an intent write alone and be live again with no proof.
 *
 * `passkey` is the exception and it is deliberate: the credentials stay, because
 * a user removing "passkey as a second factor" has not asked for their hardware
 * keys to be destroyed. With no intent row they are not offered.
 */
async function clearCapabilityFor(
  tx: Tx,
  userId: EntityID,
  method: TwoFactorMethod
): Promise<void> {
  if (method === 'totp')
    await tx
      .update(twoFactorCredentials)
      .set({ verified: false })
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
