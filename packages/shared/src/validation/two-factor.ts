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
import {
  CONTACT_KINDS,
  isPhoneChannel,
  OTP_CHANNELS,
  TWO_FACTOR_METHODS,
} from './enums';
import { parseEnumList } from './env-list';
import { MSG_CHANNEL_DISABLED, otpCodeSchema } from './otp';
import { idSchema, reauthPasswordSchema } from './rules';

export const TWO_FACTOR_METHODS_VAR = 'NEXT_PUBLIC_ENABLED_2FA_METHODS';
export const TWO_FACTOR_OTP_CHANNELS_VAR =
  'NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS';

/**
 * Deliberately a SEPARATE variable from `NEXT_PUBLIC_ENABLED_OTP_CHANNELS`: a
 * second factor delivered to the contact that can reset the password is not a
 * second factor against anyone holding that contact.
 */
const ENABLED_TWO_FACTOR_OTP_CHANNELS: readonly OtpChannel[] = parseEnumList(
  process.env.NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS,
  {
    name: TWO_FACTOR_OTP_CHANNELS_VAR,
    allowed: OTP_CHANNELS,
    noun: 'channel',
    unsetMeans: 'disable the OTP second factor',
  }
).filter((channel) => PHONE_ENABLED || !isPhoneChannel(channel));

export const ENABLED_TWO_FACTOR_METHODS: readonly TwoFactorMethod[] =
  parseEnumList(process.env.NEXT_PUBLIC_ENABLED_2FA_METHODS, {
    name: TWO_FACTOR_METHODS_VAR,
    allowed: TWO_FACTOR_METHODS,
    noun: 'method',
    unsetMeans: 'disable two-factor authentication entirely',
  });

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

// A coherence rule between the two public variables, refused wherever they are
// parsed: the method would be advertised in settings, enabled by users, and
// then fail to deliver at their next sign-in — with no session left to fix it
// from.
if (METHOD_SET.has('otp') && ENABLED_TWO_FACTOR_OTP_CHANNELS.length === 0)
  throw new Error(
    `${TWO_FACTOR_METHODS_VAR} enables "otp" but ${TWO_FACTOR_OTP_CHANNELS_VAR} names no channel. ` +
      `Set ${TWO_FACTOR_OTP_CHANNELS_VAR} to a comma-separated list of ${OTP_CHANNELS.join(', ')}, ` +
      `or remove "otp" from ${TWO_FACTOR_METHODS_VAR}.`
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
 * session for ten codes the user never saw. The value comes back from `POST
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
        message: 'يجب تحديد وسيلة الإرسال (البريد أو الهاتف)',
      });
  });

export const twoFactorMethodDisableSchema = twoFactorMethodOptionSchema.extend({
  password: reauthPasswordSchema,
});

export const twoFactorPasskeyVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

/** A row this schema stores by UUID: a trusted device, a passkey. */
export const ownedRowSchema = z.object({ id: idSchema });
