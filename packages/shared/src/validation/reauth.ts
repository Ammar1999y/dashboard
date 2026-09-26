import * as z from 'zod';

export type ReauthMethod = 'password' | 'passkey';

/**
 * `POST /api/auth/reauth/passkey/verify`: the WebAuthn assertion, opaque to
 * this schema. The verifier reads it field by field.
 */
export const reauthPasskeySchema = z
  .object({ response: z.record(z.string(), z.unknown()) })
  .strict();
