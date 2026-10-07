import * as z from 'zod';

import { OTP_BASE_RESEND_DELAY_S } from '../validation/constants';
import {
  CONTACT_KINDS,
  OTP_CHANNELS,
  TWO_FACTOR_METHODS,
} from '../validation/enums';

/**
 * A `const`, and it has to stay one: the anonymous surfaces answer identically
 * for a real and an invented identifier, so the value cannot vary with the row.
 */
export const anonymousOtpSentSchema = z.object({
  nextAllowedIn: z.number().positive().meta({ const: OTP_BASE_RESEND_DELAY_S }),
});

/**
 * For surfaces reached after proving something, a session, a recovery grant or
 * a challenge cookie (`/two-factor/otp/send`), which return the row's real
 * exponential delay.
 */
export const ladderOtpSentSchema = z.object({
  nextAllowedIn: z
    .number()
    .positive()
    .meta({ type: 'integer', minimum: OTP_BASE_RESEND_DELAY_S }),
});

export const verifiedSchema = z.object({ verified: z.literal(true) });

export const reauthGrantSchema = z.object({
  expiresIn: z.number().meta({ type: 'integer' }),
});

export const resetDoneSchema = z.object({ reset: z.literal(true) });

// `recoveryOptions` (back-end `lib/auth/two-factor/methods.ts`) drops `passkey`:
// the reset flow has no WebAuthn ceremony to check one with.
const RECOVERY_METHODS = TWO_FACTOR_METHODS.filter(
  (method) => method !== 'passkey'
);

const recoveryOptionSchema = z.object({
  id: z.string(),
  method: z.enum(TWO_FACTOR_METHODS).meta({ enum: RECOVERY_METHODS }),
  contactKind: z.enum(CONTACT_KINDS).nullable(),
  channel: z.enum(OTP_CHANNELS).nullable(),
});

/**
 * An account with a second factor never gets `reset: true` here: it gets a
 * grant, and `/forgot-password/complete` writes the password against a proven
 * factor.
 */
export const recoveryResultSchema = z.discriminatedUnion('reset', [
  resetDoneSchema,
  z.object({
    reset: z.literal(false),
    twoFactorRequired: z.literal(true),
    grant: z.string().min(1),
    options: z.array(recoveryOptionSchema),
    defaultMethod: z.string().nullable(),
  }),
]);
