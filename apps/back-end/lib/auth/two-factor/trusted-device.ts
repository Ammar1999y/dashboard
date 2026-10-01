/**
 * Replaces the plugin's trust rows, which rotate on every sign-in and cannot be
 * listed; `trustDevice` is forced off on its verify endpoints
 * (`path-policy.ts`). The cookie keeps the plugin's `<hmac>!<identifier>`
 * format, signing the user id in so one cookie cannot name another user's row.
 */
import crypto from 'node:crypto';
import type { AuthContext } from '../context';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { BetterAuthPlugin } from 'better-auth';

import { and, desc, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { trustedDevices } from '@/db/schema';
import { createHMAC } from '@better-auth/utils/hmac';
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';

import {
  HTTP_STATUS,
  MSG_INVALID_INPUT,
  MSG_NOT_FOUND,
} from '@app/shared/api-messages';
import { validID } from '@app/shared/utils';

import { logSanitized } from '@/utils/log';

import { authAuditMeta, bodyRecord } from '../context';
import { authError, sessionRequired } from '../errors';
import { twoFactorMsg } from '../messages';
import { envelopeResponse } from '../plugin-openapi';
import {
  expiresIn,
  randomToken,
  trustDeviceKey,
  twoFactorProofKey,
} from '../verifications';
import { sessionGetOptions, sessionPostOptions } from './session-endpoint';

const TRUST_COOKIE_NAME = 'trust_device';

/** Refreshed on each use, so an active device stays trusted and an idle one lapses. */
const TRUST_DEVICE_MAX_AGE_S = 30 * 24 * 60 * 60;

const IDENTIFIER_BYTES = 24;

/** Long enough for the "remember this device" click after verification, no longer. */
const TWO_FACTOR_PROOF_MAX_AGE_S = 600;

// Consumed by `/two-factor/trust-device`, binding trust to a proof rather than
// to holding a session — possibly one planted before 2FA was enabled.
export async function markTwoFactorProven(
  ctx: AuthContext,
  sessionId: string
): Promise<void> {
  await ctx.context.internalAdapter
    .createVerificationValue({
      value: sessionId,
      identifier: twoFactorProofKey(sessionId),
      expiresAt: expiresIn(TWO_FACTOR_PROOF_MAX_AGE_S),
    })
    .catch(() => {});
}

/** Single-use: a second "remember this device" needs a second verification. */
async function consumeTwoFactorProof(
  ctx: AuthContext,
  sessionId: string
): Promise<boolean> {
  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(twoFactorProofKey(sessionId))
    .catch(() => null);
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

// The identifier is deliberately not rotated on use: the row is bounded by
// `expiresAt`, user-revocable and dropped by credential rotation.
export async function consumeDeviceTrust(
  ctx: AuthContext,
  userId: EntityID
): Promise<boolean> {
  const cookie = ctx.context.createAuthCookie(TRUST_COOKIE_NAME, {
    maxAge: TRUST_DEVICE_MAX_AGE_S,
  });
  const raw = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (typeof raw !== 'string' || !raw) return false;

  const [token, identifier] = raw.split('!', 2);
  if (!token || !identifier) {
    expireCookie(ctx, cookie);
    return false;
  }

  const expected = await signTrust(ctx.context.secret, userId, identifier);
  // Length-checked first: `timingSafeEqual` throws on differing lengths.
  const matches =
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!matches) {
    expireCookie(ctx, cookie);
    return false;
  }

  const [row] = await db
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
    expireCookie(ctx, cookie);
    return false;
  }

  // Refreshed in the response too, so the cookie does not lapse before its row.
  await ctx.setSignedCookie(
    cookie.name,
    raw,
    ctx.context.secret,
    cookie.attributes
  );
  return true;
}

async function grantDeviceTrust(
  ctx: AuthContext,
  userId: EntityID
): Promise<void> {
  const identifier = trustDeviceKey(randomToken(IDENTIFIER_BYTES));
  const meta = authAuditMeta(ctx);
  const expiresAt = expiresIn(TRUST_DEVICE_MAX_AGE_S);

  try {
    await withTransaction((tx) =>
      tx.insert(trustedDevices).values({
        userId,
        trustIdentifier: identifier,
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
        expiresAt,
      })
    );
  } catch (error) {
    // Raised, not swallowed: `{ trusted: true }` would claim a device nothing recorded.
    logSanitized('error', {
      msg: 'twoFactor.trustDevice.failed',
      userId,
      error,
    });
    throw authError(HTTP_STATUS.INTERNAL_ERROR, twoFactorMsg.sendError);
  }

  const cookie = ctx.context.createAuthCookie(TRUST_COOKIE_NAME, {
    maxAge: TRUST_DEVICE_MAX_AGE_S,
  });
  await ctx.setSignedCookie(
    cookie.name,
    `${await signTrust(ctx.context.secret, userId, identifier)}!${identifier}`,
    ctx.context.secret,
    cookie.attributes
  );
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
    .orderBy(desc(trustedDevices.lastUsedAt));
}

async function revokeTrustedDevice(
  tx: Tx,
  userId: EntityID,
  deviceId: string
): Promise<boolean> {
  const [removed] = await tx
    .delete(trustedDevices)
    .where(
      and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, userId))
    )
    .returning({ id: trustedDevices.id });
  return Boolean(removed);
}

function requireSessionUserId(ctx: {
  context: { session?: { user: { id: string } } | null };
}): EntityID {
  const userId = validID(ctx.context.session?.user.id);
  if (!userId) throw sessionRequired();
  return userId;
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
      trustCurrentDevice: createAuthEndpoint(
        '/two-factor/trust-device',
        {
          method: 'POST',
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('This device is now trusted.'),
          },
        },
        async (ctx) => {
          const userId = requireSessionUserId(ctx);
          const sessionId = validID(ctx.context.session?.session.id);
          if (!sessionId) throw sessionRequired();

          if (!(await consumeTwoFactorProof(ctx, sessionId)))
            throw authError(
              HTTP_STATUS.FORBIDDEN,
              twoFactorMsg.trustRequiresProof
            );

          await grantDeviceTrust(ctx, userId);
          return ctx.json({ success: true, data: { trusted: true } });
        }
      ),

      listTrustedDevices: createAuthEndpoint(
        '/two-factor/trusted-devices',
        sessionGetOptions('The caller’s trusted devices.', {
          type: 'object',
          properties: {
            devices: { type: 'array', items: { type: 'object' } },
          },
          required: ['devices'],
        }),
        async (ctx) => {
          const userId = requireSessionUserId(ctx);
          return ctx.json({
            success: true,
            data: { devices: await listTrustedDevices(userId) },
          });
        }
      ),

      revokeTrustedDevice: createAuthEndpoint(
        '/two-factor/trusted-devices/revoke',
        sessionPostOptions('The device was revoked.'),
        async (ctx) => {
          const userId = requireSessionUserId(ctx);

          const deviceId = validID(bodyRecord(ctx).id);
          if (!deviceId)
            throw authError(HTTP_STATUS.UNPROCESSABLE, MSG_INVALID_INPUT);

          const removed = await withTransaction((tx) =>
            revokeTrustedDevice(tx, userId, deviceId)
          );
          // Another user's device and a missing one answer identically.
          if (!removed) throw authError(HTTP_STATUS.NOT_FOUND, MSG_NOT_FOUND);

          return ctx.json({ success: true, data: { revoked: true } });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
