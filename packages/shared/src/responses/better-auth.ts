/**
 * The 2xx bodies of this project's own Better Auth plugin endpoints. Each is
 * the WHOLE body: `message` comes on some endpoints and not others, and `data`
 * is left out on two, so no single envelope fits them.
 */
import * as z from 'zod';

import {
  CONTACT_KINDS,
  OTP_CHANNELS,
  TWO_FACTOR_METHODS,
  TWO_FACTOR_OPTION_IDS,
} from '../validation/enums';
import { OAUTH_PROVIDERS } from '../validation/oauth';
import { REAUTH_METHODS } from '../validation/reauth';
import { passkeyGrantSchema } from '../validation/two-factor';
import { dateTime, uuid } from './common';

/** `{ data }`, the plugin body without a message. */
export const pluginBody = <D extends z.ZodType>(data: D) => z.object({ data });

export const pluginBodyWithMessage = <D extends z.ZodType>(data: D) =>
  z.object({ message: z.string(), data });

/** What the endpoints that answer a message and no `data` key at all send. */
export const pluginMessage = () => z.object({ message: z.string() });

// The client accepts any string, so an option added between deploys parses;
// the list is what the server can produce today.
const optionIdOf = () => z.string().meta({ enum: TWO_FACTOR_OPTION_IDS });

const challengeOptionSchema = z.object({
  id: optionIdOf(),
  method: z.enum(TWO_FACTOR_METHODS),
  contactKind: z.enum(CONTACT_KINDS).nullable(),
  channel: z.enum(OTP_CHANNELS).nullable(),
  nextAllowedIn: z.number().nonnegative().optional().meta({ type: 'integer' }),
});

/** A first factor that passed on a two-factor account: no session yet. */
export const twoFactorChallengeSchema = z.object({
  twoFactorRedirect: z.literal(true),
  twoFactorMethods: z
    .array(z.enum(TWO_FACTOR_METHODS))
    .meta({ uniqueItems: true }),
  twoFactorOptions: z.array(challengeOptionSchema),
  defaultMethod: optionIdOf().nullable(),
});

export const loggedInSchema = z.object({ loggedIn: z.literal(true) });

// `@simplewebauthn` 13's value sets. The back-end checks this schema against
// the library's `PublicKeyCredentialRequestOptionsJSON` in both directions
// (`lib/auth/passkey-assertion.ts`), so an upgrade that changes the type
// fails there.
const AUTHENTICATOR_TRANSPORTS = [
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
] as const;
const CREDENTIAL_HINTS = ['hybrid', 'security-key', 'client-device'] as const;
const USER_VERIFICATION = ['required', 'preferred', 'discouraged'] as const;
const BASE64URL_PATTERN = '^[A-Za-z0-9_-]+$';

/**
 * Handed to the browser's WebAuthn ceremony as it came. `extensions` mirrors
 * the library's closed type: the server never sets it.
 */
export const passkeyRequestOptionsSchema = z.object({
  challenge: z.string().min(1).meta({ pattern: BASE64URL_PATTERN }),
  timeout: z.number().optional().meta({ type: 'integer', exclusiveMinimum: 0 }),
  rpId: z.string().optional(),
  allowCredentials: z
    .array(
      z.object({
        id: z.string().meta({ pattern: BASE64URL_PATTERN }),
        type: z.literal('public-key'),
        transports: z.array(z.enum(AUTHENTICATOR_TRANSPORTS)).optional(),
      })
    )
    .optional()
    // The options are refused for an account without a passkey.
    .meta({ minItems: 1 }),
  userVerification: z
    .enum(USER_VERIFICATION)
    .optional()
    // Every assertion is verified with user verification required.
    .meta({ enum: ['required'] }),
  hints: z.array(z.enum(CREDENTIAL_HINTS)).optional(),
  extensions: z
    .object({
      appid: z.string().optional(),
      credProps: z.boolean().optional(),
      hmacCreateSecret: z.boolean().optional(),
      minPinLength: z.boolean().optional(),
    })
    .optional(),
});

/** `/passwordless/verify`: a session, or the challenge in its place. */
export const passwordlessResultSchema = z.xor([
  pluginBodyWithMessage(loggedInSchema),
  twoFactorChallengeSchema,
]);

/**
 * The Google sign-in's outcome, answered by the callback directly or kept for
 * `/oauth/result`. The session body carries no message.
 */
export const oauthOutcomeSchema = z.xor([
  pluginBody(loggedInSchema),
  twoFactorChallengeSchema,
]);

export const capabilitiesSchema = z.object({
  oauthProviders: z.array(z.enum(OAUTH_PROVIDERS)).meta({ uniqueItems: true }),
});

export const reauthMethodsSchema = z.object({
  methods: z.array(z.enum(REAUTH_METHODS)).meta({ uniqueItems: true }),
});

/** Navigated to, so only a web URL qualifies. */
export const oauthStartedSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).meta({ pattern: '^https?://' }),
});

export const totpStartedSchema = z.object({
  totpURI: z
    .string()
    .min(1)
    .meta({ format: 'uri', pattern: '^otpauth://totp/' }),
});

export const totpEnabledSchema = z.object({ method: z.literal('totp') });

export const backupCodesSchema = z.object({
  backupCodes: z.array(z.string()),
  setId: uuid(),
});

export const enrolledMethodSchema = z.object({
  method: z.enum(TWO_FACTOR_METHODS),
  channel: z.enum(OTP_CHANNELS).nullable(),
  contactKind: z.enum(CONTACT_KINDS).nullable(),
  isDefault: z.boolean(),
});

export const enrolledMethodsSchema = z.object({
  methods: z.array(enrolledMethodSchema),
});

export const removedMethodSchema = z.object({ removedMethod: optionIdOf() });

export const defaultMethodSchema = z.object({ defaultMethod: optionIdOf() });

export const passkeyDeletedSchema = z.object({ deleted: z.literal(true) });

export const passkeyGrantedSchema = z.object({ grant: passkeyGrantSchema });

export const otpEnabledSchema = z.object({
  method: z.literal('otp'),
  channel: z.enum(OTP_CHANNELS),
});

export const deviceTrustedSchema = z.object({ trusted: z.literal(true) });

export const trustedDeviceSchema = z.object({
  id: uuid(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  lastUsedAt: dateTime(),
  expiresAt: dateTime(),
  createdAt: dateTime(),
});

export const trustedDevicesSchema = z.object({
  devices: z.array(trustedDeviceSchema),
});

export const deviceRevokedSchema = z.object({ revoked: z.literal(true) });
