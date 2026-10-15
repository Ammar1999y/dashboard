/**
 * Which second factors this deployment offers, and where a 2FA OTP is delivered.
 *
 * `lib/auth/allowed-paths.ts` derives the served Better Auth paths from
 * `ENABLED_TWO_FACTOR_METHODS`, so a disabled method's endpoints answer 404
 * rather than being merely hidden.
 *
 * Both variables are read by their literal names: this module is bundled for
 * the browser too, where only a literal `process.env.NEXT_PUBLIC_*` access is
 * inlined. The provider-credential gate and the operator notices are
 * server-only and live in the back-end's `lib/otp/config.ts`.
 */
import type { OtpChannel, TwoFactorMethod } from './enums';

import * as z from 'zod';

import { PHONE_ENABLED } from '../config';
import { MSG_CHANNEL_DISABLED } from '../messages/otp';
import { MSG_TWO_FACTOR_CONTACT_REQUIRED } from '../messages/validation';
import { CONTACT_KINDS, isPhoneChannel, TWO_FACTOR_METHODS } from './enums';
import { otpCodeSchema } from './otp';
import { idSchema, reauthPasswordSchema } from './rules';
import {
  assertTwoFactorListsCoherent,
  parseTwoFactorMethods,
  parseTwoFactorOtpChannels,
} from './two-factor-lists';

/**
 * Deliberately a SEPARATE variable from `NEXT_PUBLIC_ENABLED_OTP_CHANNELS`: a
 * second factor delivered to the contact that can reset the password is not a
 * second factor against anyone holding that contact.
 */
const ENABLED_TWO_FACTOR_OTP_CHANNELS: readonly OtpChannel[] =
  parseTwoFactorOtpChannels(
    process.env.NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS
  ).filter((channel) => PHONE_ENABLED || !isPhoneChannel(channel));

export const ENABLED_TWO_FACTOR_METHODS: readonly TwoFactorMethod[] =
  parseTwoFactorMethods(process.env.NEXT_PUBLIC_ENABLED_2FA_METHODS);

const METHOD_SET = new Set<string>(ENABLED_TWO_FACTOR_METHODS);
const CHANNEL_SET = new Set<string>(ENABLED_TWO_FACTOR_OTP_CHANNELS);

export const TWO_FACTOR_ENABLED = ENABLED_TWO_FACTOR_METHODS.length > 0;

export function isTwoFactorMethodEnabled(
  method: string
): method is TwoFactorMethod {
  return METHOD_SET.has(method);
}

export function isTwoFactorOtpChannelEnabled(
  channel: string
): channel is OtpChannel {
  return CHANNEL_SET.has(channel);
}

export const TWO_FACTOR_OTP_AVAILABLE =
  METHOD_SET.has('otp') && ENABLED_TWO_FACTOR_OTP_CHANNELS.length > 0;

export const TWO_FACTOR_OTP_CHANNELS = ENABLED_TWO_FACTOR_OTP_CHANNELS;

// eslint-disable-next-line unicorn/no-top-level-side-effects -- refusing to load is this gate's contract; see the root CLAUDE.md
assertTwoFactorListsCoherent(
  ENABLED_TWO_FACTOR_METHODS,
  ENABLED_TWO_FACTOR_OTP_CHANNELS
);

// The 2FA surfaces take no identifier from the client: the user is known from
// the session when enrolling and from the challenge cookie when signing in.

/**
 * Validated against the 2FA-enabled channels rather than `OTP_CHANNELS`: a
 * channel with no provider configured would enrol a method that cannot deliver.
 */
const enabledTwoFactorChannel = z
  .string()
  .refine(isTwoFactorOtpChannelEnabled, MSG_CHANNEL_DISABLED);

export const twoFactorOtpEnrollSchema = z.object({
  channel: enabledTwoFactorChannel,
});

/** An offered option's identity — `otp:email`, `otp:phone`, `totp`, … */
const optionIdSchema = z.string().min(1).max(40);

/**
 * The published body of `/two-factor/otp/send`, covering both modes: `channel`
 * and `password` on the enrolment branch (a session), `option` on the sign-in
 * branch (a challenge).
 */
export const twoFactorOtpSendSchema = z.object({
  channel: enabledTwoFactorChannel.optional(),
  option: optionIdSchema.optional(),
  password: reauthPasswordSchema,
});

export const twoFactorOtpVerifySchema = z.object({
  code: otpCodeSchema,
  channel: enabledTwoFactorChannel.optional(),
  option: optionIdSchema.optional(),
});

/** Re-authentication alone: TOTP setup, backup-code generation, disable, the passkey grant. */
export const twoFactorPasswordSchema = z.object({
  password: reauthPasswordSchema,
});

export const twoFactorTotpConfirmSchema = z.object({ code: otpCodeSchema });

/**
 * Which SET of backup codes is being acknowledged.
 *
 * Required, and that is the whole point: without it the acknowledgement lands on
 * whichever set is current, which enables the method and revokes every other
 * session for codes the user never saw. The value comes back from `POST
 * /two-factor/generate-backup-codes` beside the codes it names, so a client
 * always holds the one for the set it displayed.
 */
export const twoFactorBackupAcknowledgeSchema = z.object({
  setId: idSchema,
});

/**
 * The published body. The handler parses `setId` alone and proves the password
 * through `requireReauthPassword`, as every sibling that takes one does: parsing
 * it here would answer 422 for a stored credential that no longer satisfies the
 * current policy.
 */
export const twoFactorBackupAcknowledgeBodySchema =
  twoFactorPasswordSchema.extend(twoFactorBackupAcknowledgeSchema.shape);

/**
 * The `superRefine` below as a document rule. `properties` names the
 * field the outer schema defines, so a linter can resolve the `required`.
 * `.extend()` drops metadata, so every extension declares it again.
 */
const OTP_NEEDS_CONTACT_KIND = [
  {
    if: { properties: { method: { const: 'otp' } }, required: ['method'] },
    // eslint-disable-next-line unicorn/no-thenable -- JSON Schema 2020-12 keyword paired with `if`, not a promise
    then: { properties: { contactKind: {} }, required: ['contactKind'] },
  },
];

/**
 * Names ONE enrolment: `contactKind` distinguishes a user's two OTP rows.
 *
 * Required for `otp`, because a user may hold both an email and a phone
 * enrolment and `{ method: 'otp' }` alone would resolve to whichever row sorts
 * first. The methods listing returns `contactKind` on every entry.
 */
export const twoFactorMethodOptionSchema = z
  .object({
    method: z.enum(TWO_FACTOR_METHODS),
    contactKind: z.enum(CONTACT_KINDS).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.method === 'otp' && value.contactKind === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['contactKind'],
        message: MSG_TWO_FACTOR_CONTACT_REQUIRED,
      });
  })
  .meta({ allOf: OTP_NEEDS_CONTACT_KIND });

export const twoFactorMethodDisableSchema = twoFactorMethodOptionSchema
  .extend({ password: reauthPasswordSchema })
  .meta({ allOf: OTP_NEEDS_CONTACT_KIND });

export const twoFactorPasskeyVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

/** A row this schema stores by UUID: a trusted device, a passkey. */
export const ownedRowSchema = z.object({ id: idSchema });

/** The random bytes behind a `/two-factor/passkey/grant` grant. */
export const REAUTH_GRANT_BYTES = 24;

/** Long enough for a WebAuthn ceremony a user has to walk through, and no longer. */
export const REAUTH_GRANT_MAX_AGE_S = 600;

/** What `/two-factor/passkey/grant` answers with; single use, and bound to the account. */
export const passkeyGrantSchema = z
  .string()
  // Unpadded base64url.
  .length(Math.ceil((REAUTH_GRANT_BYTES * 4) / 3))
  .regex(/^[\w-]+$/);

export const passkeyDeleteSchema = ownedRowSchema.extend({
  grant: passkeyGrantSchema,
});
