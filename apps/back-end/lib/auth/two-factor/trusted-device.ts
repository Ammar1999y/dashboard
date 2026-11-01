/**
 * Replaces the plugin's trust rows, which rotate on every sign-in and cannot be
 * listed; `trustDevice` is forced off on its verify endpoints
 * (`path-policy.ts`). The cookie keeps the plugin's `<hmac>!<identifier>`
 * format, signing the user id in so one cookie cannot name another user's row.
 */
import crypto from 'node:crypto';
import type { AuthContext } from '../context';
import type { Executor, Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { BetterAuthPlugin } from 'better-auth';

import { and, asc, desc, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { inList } from '@/db/arrays';
import { trustedDevices } from '@/db/schema';
import { createHMAC } from '@better-auth/utils/hmac';
import { expireCookie } from 'better-auth/cookies';

import * as contract from '@app/shared/api/better-auth';
import { HTTP_STATUS } from '@app/shared/http-status';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { MSG_INVALID_INPUT, MSG_NOT_FOUND } from '@app/shared/messages/common';
import { validID } from '@app/shared/utils';
import { ownedRowSchema } from '@app/shared/validation/two-factor';

import { auditLog } from '@/lib/audit';

import { authAuditMeta, parseAuthBody } from '../context';
import { authError, sessionRequired } from '../errors';
import { pluginEndpoint } from '../plugin-endpoint';
import { lockSessionOwner } from '../session/live';
import { withAuthTransaction } from '../transaction';
import {
  expiresIn,
  randomToken,
  replaceVerification,
  trustDeviceKey,
  twoFactorProofKey,
} from '../verifications';
import { sessionBodyOptions, sessionOptions } from './session-endpoint';

const TRUST_COOKIE_NAME = 'trust_device';

/** Refreshed on each use, so an active device stays trusted and an idle one lapses. */
const TRUST_DEVICE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Live trusted devices per account; each grant past it evicts the least used. */
export const MAX_TRUSTED_DEVICES = 20;

const IDENTIFIER_BYTES = 24;

/** Long enough for the "remember this device" click after verification, no longer. */
const TWO_FACTOR_PROOF_MAX_AGE_S = 600;

/**
 * Consumed by `/two-factor/trust-device`, binding trust to a proof rather than
 * to holding a session — possibly one planted before 2FA was enabled.
 *
 * ⚠️ Only in the transaction that accepted the factor, after its user lock.
 * Method removal revokes proofs under that lock; one issued after the commit
 * can land behind a removal and earn trust against the removed factor.
 */
export async function markTwoFactorProven(
  tx: Tx,
  sessionId: string
): Promise<void> {
  await replaceVerification(
    tx,
    twoFactorProofKey(sessionId),
    sessionId,
    expiresIn(TWO_FACTOR_PROOF_MAX_AGE_S)
  );
}

/** Single-use: a second "remember this device" needs a second verification. */
async function consumeTwoFactorProof(
  ctx: AuthContext,
  sessionId: string
): Promise<boolean> {
  const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
    twoFactorProofKey(sessionId)
  );
  return consumed?.value === sessionId;
}

/** The primitive the plugin signs this cookie format with, so the two cannot drift. */
function signTrust(
  secret: string,
  userId: string,
  identifier: string
): Promise<string> {
  return createHMAC('SHA-256', 'base64urlnopad').sign(
    secret,
    `${userId}!${identifier}`
  );
}

function trustCookie(ctx: AuthContext) {
  return ctx.context.createAuthCookie(TRUST_COOKIE_NAME, {
    maxAge: TRUST_DEVICE_MAX_AGE_S,
  });
}

/** The identifier a cookie signed for `userId` names. Any other cookie is expired. */
async function presentedTrustIdentifier(
  ctx: AuthContext,
  userId: EntityID
): Promise<string | null> {
  const cookie = trustCookie(ctx);
  const raw = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (typeof raw !== 'string' || !raw) return null;

  const [token, identifier] = raw.split('!', 2);
  if (token && identifier) {
    const expected = await signTrust(ctx.context.secret, userId, identifier);
    // Length-checked first: `timingSafeEqual` throws on differing lengths.
    if (
      token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      return identifier;
  }
  expireCookie(ctx, cookie);
  return null;
}

async function setTrustCookie(
  ctx: AuthContext,
  userId: EntityID,
  identifier: string
): Promise<void> {
  const cookie = trustCookie(ctx);
  await ctx.setSignedCookie(
    cookie.name,
    `${await signTrust(ctx.context.secret, userId, identifier)}!${identifier}`,
    ctx.context.secret,
    cookie.attributes
  );
}

/**
 * The id of the row the request's trust cookie names, or `null`. The
 * identifier is deliberately not rotated on use: the row is bounded by
 * `expiresAt`, user-revocable and dropped by credential rotation.
 */
export async function consumeDeviceTrust(
  ctx: AuthContext,
  userId: EntityID,
  executor: Executor = db
): Promise<EntityID | null> {
  const identifier = await presentedTrustIdentifier(ctx, userId);
  if (!identifier) return null;

  const [row] = await executor
    .update(trustedDevices)
    .set({
      lastUsedAt: new Date(),
      expiresAt: expiresIn(TRUST_DEVICE_MAX_AGE_S),
    })
    .where(
      and(
        eq(trustedDevices.trustIdentifier, identifier),
        eq(trustedDevices.userId, userId),
        gt(trustedDevices.expiresAt, new Date())
      )
    )
    .returning({ id: trustedDevices.id });

  if (!row) {
    expireCookie(ctx, trustCookie(ctx));
    return null;
  }

  // Refreshed in the response too, so the cookie does not lapse before its row.
  await setTrustCookie(ctx, userId, identifier);
  return row.id;
}

/**
 * ⚠️ Proof and row under the user lock that method removal revokes trust with
 * (`revokeTwoFactorState`): removal then either waits and deletes this row, or
 * runs first and takes the proof. Spent apart, a removal could land between.
 */
async function grantDeviceTrust(
  ctx: AuthContext,
  userId: EntityID,
  sessionId: string
): Promise<void> {
  const identifier = trustDeviceKey(randomToken(IDENTIFIER_BYTES));
  const meta = authAuditMeta(ctx);
  // The cookie set below replaces it, so its row could never be used again.
  const replacing = await presentedTrustIdentifier(ctx, userId);

  await withAuthTransaction(ctx, async (tx) => {
    const user = await lockSessionOwner(tx, userId, sessionId);
    if (!user) throw sessionRequired();
    if (!(await consumeTwoFactorProof(ctx, sessionId)))
      throw authError(HTTP_STATUS.FORBIDDEN, twoFactorMsg.trustRequiresProof);
    const [replaced] = replacing
      ? await tx
          .delete(trustedDevices)
          .where(
            and(
              eq(trustedDevices.trustIdentifier, replacing),
              eq(trustedDevices.userId, userId)
            )
          )
          .returning({ id: trustedDevices.id })
      : [];
    // Under the user lock, so concurrent grants cannot each see room. The
    // least recently used goes; that device asks for its second factor again.
    const live = await tx
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          gt(trustedDevices.expiresAt, new Date())
        )
      )
      .orderBy(asc(trustedDevices.lastUsedAt), asc(trustedDevices.id));
    const evicted = live
      .slice(0, Math.max(0, live.length - MAX_TRUSTED_DEVICES + 1))
      .map((row) => row.id);
    if (evicted.length > 0)
      await tx.delete(trustedDevices).where(inList(trustedDevices.id, evicted));
    const [device] = await tx
      .insert(trustedDevices)
      .values({
        userId,
        trustIdentifier: identifier,
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
        expiresAt: expiresIn(TRUST_DEVICE_MAX_AGE_S),
      })
      .returning({ id: trustedDevices.id });
    if (!device) throw new Error('The trusted-device insert returned no row');
    await auditLog(tx, {
      userId,
      userEmail: user.email,
      action: 'INSERT',
      tableName: 'trusted_devices',
      recordId: device.id,
      oldData: null,
      newData: {
        deviceTrusted: true,
        ...(replaced && { replacedDeviceId: replaced.id }),
        ...(evicted.length > 0 && { evictedDeviceIds: evicted }),
      },
      meta,
    });
  });

  await setTrustCookie(ctx, userId, identifier);
}

async function listTrustedDevices(userId: EntityID) {
  return db
    .select({
      id: trustedDevices.id,
      userAgent: trustedDevices.userAgent,
      ipAddress: trustedDevices.ipAddress,
      lastUsedAt: trustedDevices.lastUsedAt,
      expiresAt: trustedDevices.expiresAt,
      createdAt: trustedDevices.createdAt,
    })
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, userId),
        gt(trustedDevices.expiresAt, new Date())
      )
    )
    .orderBy(desc(trustedDevices.lastUsedAt))
    .limit(MAX_TRUSTED_DEVICES);
}

async function revokeTrustedDevice(
  ctx: AuthContext,
  userId: EntityID,
  sessionId: string,
  deviceId: EntityID
): Promise<boolean> {
  return withTransaction(async (tx) => {
    // Before the row: rotation deletes these rows holding the user lock that
    // the audit row's foreign key waits for.
    const user = await lockSessionOwner(tx, userId, sessionId);
    if (!user) throw sessionRequired();
    const [removed] = await tx
      .delete(trustedDevices)
      .where(
        and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, userId))
      )
      .returning({ id: trustedDevices.id });
    if (!removed) return false;
    await auditLog(tx, {
      userId,
      userEmail: user.email,
      action: 'DELETE',
      tableName: 'trusted_devices',
      recordId: removed.id,
      oldData: { deviceTrusted: true },
      newData: { deviceTrusted: false },
      meta: authAuditMeta(ctx),
    });
    return true;
  });
}

function requireSessionUserId(ctx: {
  context: { session?: { user: { id: string } } | null };
}): EntityID {
  const userId = validID(ctx.context.session?.user.id);
  if (!userId) throw sessionRequired();
  return userId;
}

function requireSessionId(ctx: {
  context: { session?: { session: { id: string } } | null };
}): string {
  const sessionId = validID(ctx.context.session?.session.id);
  if (!sessionId) throw sessionRequired();
  return sessionId;
}

/**
 * Also behind `LIVE_SESSION_PATHS` (`path-policy.ts`): Better Auth's session
 * resolution answers from the cookie cache without checking the user is active.
 *
 * ⚠️ FRONTEND: "remember this device" is two calls — verify, then
 * `/two-factor/trust-device`.
 */
export const trustedDevice = () =>
  ({
    id: 'trusted-device',
    endpoints: {
      trustCurrentDevice: pluginEndpoint(
        contract.trustCurrentDevice,
        sessionOptions(),
        async (ctx) => {
          const userId = requireSessionUserId(ctx);
          const sessionId = requireSessionId(ctx);

          await grantDeviceTrust(ctx, userId, sessionId);
          return ctx.json({ data: { trusted: true } });
        }
      ),

      listTrustedDevices: pluginEndpoint(
        contract.listTrustedDevices,
        sessionOptions(),
        async (ctx) => {
          const userId = requireSessionUserId(ctx);
          return ctx.json({
            data: { devices: await listTrustedDevices(userId) },
          });
        }
      ),

      revokeTrustedDevice: pluginEndpoint(
        contract.revokeTrustedDevice,
        sessionBodyOptions(),
        async (ctx) => {
          const userId = requireSessionUserId(ctx);
          const sessionId = requireSessionId(ctx);
          const { id: deviceId } = parseAuthBody(
            ctx,
            ownedRowSchema,
            MSG_INVALID_INPUT
          );

          const removed = await revokeTrustedDevice(
            ctx,
            userId,
            sessionId,
            deviceId
          );
          // Another user's device and a missing one answer identically.
          if (!removed) throw authError(HTTP_STATUS.NOT_FOUND, MSG_NOT_FOUND);

          return ctx.json({ data: { revoked: true } });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
