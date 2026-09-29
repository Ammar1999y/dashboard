/**
 * Trusted devices: the one mechanism here that skips the second factor, and so
 * the one a user has to be able to see and revoke.
 *
 * The plugin's own version is a bare `verification` row holding a user id, whose
 * identifier rotates on every sign-in — nothing to list, and any companion
 * record would be orphaned within one login. `trustDevice` is therefore forced
 * off on the plugin's verify endpoints (`lib/auth/path-policy.ts`) and every
 * record that grants a skip is written here.
 *
 * The cookie keeps the plugin's format, `<hmac>!<identifier>` over
 * `<userId>!<identifier>`. Binding the user into the signature is what stops a
 * holder of one device's cookie naming another user's row.
 */
import crypto from 'node:crypto';
import type { AuthContext } from '../context';
import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { BetterAuthPlugin } from 'better-auth';

import { and, desc, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { trustedDevices } from '@/db/schema';
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

/**
 * How long a completed second factor stays redeemable for a device-trust grant:
 * long enough for a "remember this device" click on the page that follows the
 * verification, short enough that a session cannot cash it in days later.
 */
const TWO_FACTOR_PROOF_MAX_AGE_S = 600;

/**
 * Records that THIS session was created by completing a second factor.
 *
 * `/two-factor/trust-device` consumes it, which is what binds a 30-day challenge
 * skip to a proof rather than to the mere possession of a session — including
 * one planted before the user enabled 2FA at all.
 */
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

/**
 * `node:crypto` rather than `@better-auth/utils/hmac`, a transitive dependency
 * this project does not declare. The encoding is pinned by the cookie format.
 */
function signTrust(secret: string, userId: string, identifier: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${userId}!${identifier}`, 'utf8')
    .digest('base64url');
}

/**
 * Whether this request carries trust for `userId`, refreshing it if so. Any
 * failure expires the cookie rather than leaving a value that fails again on
 * every later request.
 *
 * The identifier is deliberately not rotated on use: the row is already bounded
 * by `expiresAt`, revocable by the user, and dropped by credential rotation.
 */
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

  const expected = signTrust(ctx.context.secret, userId, identifier);
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
    // Raised, not swallowed. The caller keeps its session either way, but
    // answering `{ trusted: true }` with no row and no cookie tells the user
    // this device is remembered when nothing recorded it.
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
    `${signTrust(ctx.context.secret, userId, identifier)}!${identifier}`,
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

/**
 * The ownership predicate is in the WHERE clause rather than a prior read: a
 * check-then-delete would let a concurrent request move the row between the two.
 */
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

/** The session user, or the 401 every endpoint here answers without one. */
function requireSessionUserId(ctx: {
  context: { session?: { user: { id: string } } | null };
}): EntityID {
  const userId = validID(ctx.context.session?.user.id);
  if (!userId) throw sessionRequired();
  return userId;
}

/**
 * Session-gated, plus `assertLiveSession` through `LIVE_SESSION_PATHS` in
 * `lib/auth/path-policy.ts`: Better Auth's own session resolution answers from
 * the cookie cache and asks nothing about whether the user is still active.
 *
 * Granting is its own endpoint rather than a `trustDevice` flag on each verify
 * call, because the plugin's verify endpoints have that flag forced off.
 *
 * ⚠️ FRONTEND: a "remember this device" checkbox on the 2FA prompt is TWO calls
 * — verify, then this — not a field on the first.
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

          // A session alone is not enough. This grants a 30-day skip of the
          // second factor, so it is redeemable only against a single-use proof
          // that THIS session was created by completing one — otherwise a
          // session planted before the user enabled 2FA could mint the skip.
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
          // A device that is not the caller's and one that does not exist answer
          // identically, so the response cannot probe for other users' rows.
          if (!removed) throw authError(HTTP_STATUS.NOT_FOUND, MSG_NOT_FOUND);

          return ctx.json({ success: true, data: { revoked: true } });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
