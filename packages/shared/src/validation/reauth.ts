import * as z from 'zod';

export const REAUTH_METHODS = ['password', 'passkey'] as const;
export type ReauthMethod = (typeof REAUTH_METHODS)[number];

/**
 * `POST /api/auth/reauth/passkey/verify`: the WebAuthn assertion, opaque to
 * this schema. The verifier reads it field by field.
 */
export const reauthPasskeySchema = z
  .object({ response: z.record(z.string(), z.unknown()) })
  .strict();
