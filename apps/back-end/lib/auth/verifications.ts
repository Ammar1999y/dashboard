/**
 * Every `identifier` this codebase writes to `verifications`, in one place
 * because rotation and session deletion find rows by these prefixes.
 *
 * ⚠️ `2fa-` and `2fa-attempts-` are Better Auth's private formats, mirrored:
 * its two-factor verifiers read those rows (see `two-factor/challenge.ts`).
 */
import crypto from 'node:crypto';
import type { Tx } from '@/db';

import { eq } from 'drizzle-orm';

import { verifications } from '@/db/schema';

export const twoFactorChallengeKey = (token: string) => `2fa-${token}`;
/** `LIKE` pattern matching every `2fa-*` row. */
export const TWO_FACTOR_KEY_PATTERN = '2fa-%';
export const twoFactorAttemptsKey = (challengeId: string) =>
  `2fa-attempts-${challengeId}`;
export const twoFactorStateKey = (challengeId: string) =>
  `2fa-state-${challengeId}`;
export const twoFactorWebauthnKey = (challengeId: string) =>
  `2fa-webauthn-${challengeId}`;
export const twoFactorProofKey = (sessionId: string) =>
  `2fa-proven-${sessionId}`;

export const trustDeviceKey = (token: string) => `trust-device-${token}`;

export const adminReauthKey = (sessionId: string) =>
  `admin-reauth-${sessionId}`;
export const reauthMethodKey = (sessionId: string) =>
  `reauth-method-${sessionId}`;
export const reauthPasskeyKey = (sessionId: string) =>
  `reauth-passkey-${sessionId}`;
export const reauthGrantKey = (purpose: string, token: string) =>
  `reauth-${purpose}-${token}`;

export const oauthOnceKey = (state: string) => `oauth-once-${state}`;
export const oauthResultKey = (token: string) => `oauth-result-${token}`;
export const oauthResultOwnerKey = (token: string) =>
  `oauth-result-owner-${token}`;

export const recoveryKey = (token: string) => `recovery-${token}`;
export const recoveryStateKey = (token: string) => `recovery-state-${token}`;
export const recoveryAttemptsKey = (token: string) =>
  `recovery-attempts-${token}`;

export function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/** `identifier` is not unique in the schema; this is what keeps it to one row. */
export async function replaceVerification(
  tx: Tx,
  identifier: string,
  value: string,
  expiresAt: Date
): Promise<void> {
  await tx
    .delete(verifications)
    .where(eq(verifications.identifier, identifier));
  await tx.insert(verifications).values({ identifier, value, expiresAt });
}
