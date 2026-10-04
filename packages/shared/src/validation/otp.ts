import type { OtpChannel } from './enums';

import * as z from 'zod';

import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '../config';
import { MSG_CHANNEL_DISABLED } from '../messages/otp';
import {
  MSG_OTP_DIGITS_ONLY,
  MSG_OTP_REQUIRED,
  MSG_OTP_WRONG_LENGTH,
  MSG_RECOVERY_CODE_INVALID,
} from '../messages/validation';
import { OTP_CODE_LENGTH } from './constants';
import {
  EMAIL_OTP_CHANNELS,
  isPhoneChannel,
  OTP_CHANNELS,
  PHONE_OTP_CHANNELS,
} from './enums';
import { parseEnumList } from './env-list';
import {
  emailSchema,
  passwordSchema,
  phoneSchema,
  sanitizeStrictSingleLine,
  STRICT_SINGLE_LINE_DESCRIPTION,
} from './rules';

/**
 * Channels listed in the env, parsed strictly (`parseEnumList`). Phone channels
 * are STRIPPED rather than rejected when `PHONE_NUMBER_MODE` disables phone:
 * that is a coherent configuration, not a mistake in this variable.
 */
const envChannels: OtpChannel[] = parseEnumList(
  process.env.NEXT_PUBLIC_ENABLED_OTP_CHANNELS,
  {
    name: 'NEXT_PUBLIC_ENABLED_OTP_CHANNELS',
    allowed: OTP_CHANNELS,
    noun: 'channel',
    unsetMeans: 'disable OTP entirely',
  }
).filter((c) => PHONE_ENABLED || !isPhoneChannel(c));

// `OTP_AUTO_VERIFY` skips code entry on contact verification and the
// authenticated contact-change endpoints, so their channels stay offered with
// none configured. It does NOT stop delivery: recovery and passwordless always
// issue a real code, which is why the back-end's credential gate
// (`lib/otp/config.ts`) reads this widened set rather than the variable alone.
const bypassChannels: readonly OtpChannel[] = OTP_AUTO_VERIFY
  ? [...EMAIL_OTP_CHANNELS, ...(PHONE_ENABLED ? PHONE_OTP_CHANNELS : [])]
  : [];

/** Empty means OTP is completely disabled. */
export const ENABLED_OTP_CHANNELS: readonly OtpChannel[] = [
  ...new Set([...envChannels, ...bypassChannels]),
];

export const OTP_ENABLED = ENABLED_OTP_CHANNELS.length > 0;

/** Narrows unvalidated input to a channel that is enabled right now. */
export function isChannelEnabled(channel: string): channel is OtpChannel {
  return (ENABLED_OTP_CHANNELS as readonly string[]).includes(channel);
}

/** A channel capable of verifying the email / the phone is enabled. */
export const EMAIL_OTP_AVAILABLE = EMAIL_OTP_CHANNELS.some(isChannelEnabled);
export const PHONE_OTP_AVAILABLE = PHONE_OTP_CHANNELS.some(isChannelEnabled);

/**
 * The requested channel must be enabled — on the SEND schemas only, the single
 * place this is enforced. A send selects a provider and spends money at one. A
 * verify does not: the proof row and its quota are keyed by contact kind, which
 * collapses `sms` and `whatsapp` onto `'phone'`, so checking the channel there
 * would strand a valid code delivered over a since-disabled sibling.
 */
function channelEnabledRefine(data: { channel: string }, ctx: z.RefinementCtx) {
  if (!isChannelEnabled(data.channel)) {
    ctx.addIssue({
      code: 'custom',
      message: MSG_CHANNEL_DISABLED,
    });
  }
}

export const otpCodeSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string(MSG_OTP_REQUIRED)
    .length(OTP_CODE_LENGTH, MSG_OTP_WRONG_LENGTH)
    .regex(/^[0-9]+$/, MSG_OTP_DIGITS_ONLY)
    // The one sanitized leaf whose rule a raw-input `pattern` can carry, so it
    // does: `length()` publishes an exact 6 that refuses the pasted ` 123456 `
    // this schema trims and accepts — the common shape for a code copied out of
    // a message.
    //
    // ⚠️ The separator class is "not a digit", not whitespace. The sanitizer
    // removes every character outside its allow-list, and a zero-width space
    // (U+200B, which `\s` does not match) is exactly the kind a rich-text copy
    // leaves behind: `12​3456` is accepted as `123456`. The pattern is
    // therefore laxer than the schema — it also admits separators the sanitizer
    // KEEPS, like `12.3456`, which the digits-only check then refuses — and that
    // is the direction to err in, because only the other one refuses a request
    // the server would have answered.
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: `^[^0-9]*(?:[0-9][^0-9]*){${OTP_CODE_LENGTH}}$`,
      description: STRICT_SINGLE_LINE_DESCRIPTION,
    })
);

const sendOtpPhoneSchema = z.object({
  channel: z.literal('whatsapp'),
  phoneNumber: phoneSchema,
});

const sendOtpEmailSchema = z.object({
  channel: z.literal('email'),
  email: emailSchema,
});

const sendOtpSmsSchema = z.object({
  channel: z.literal('sms'),
  phoneNumber: phoneSchema,
});

export const sendOtpSchema = z
  .discriminatedUnion('channel', [
    sendOtpPhoneSchema,
    sendOtpEmailSchema,
    sendOtpSmsSchema,
  ])
  .superRefine(channelEnabledRefine);

const codeField = { code: otpCodeSchema };
const verifyOtpPhoneSchema = sendOtpPhoneSchema.extend(codeField);
const verifyOtpEmailSchema = sendOtpEmailSchema.extend(codeField);
const verifyOtpSmsSchema = sendOtpSmsSchema.extend(codeField);

/** The verify bodies plus `shape`, one per channel. */
function verifyOtpWith<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.discriminatedUnion('channel', [
    verifyOtpPhoneSchema.extend(shape),
    verifyOtpEmailSchema.extend(shape),
    verifyOtpSmsSchema.extend(shape),
  ]);
}

export const verifyOtpSchema = z.discriminatedUnion('channel', [
  verifyOtpPhoneSchema,
  verifyOtpEmailSchema,
  verifyOtpSmsSchema,
]);

/**
 * `/passwordless/verify` issues a session, so it carries the same `rememberMe`
 * `/sign-in/email` does. Absent means remembered — see `submittedRememberMe`.
 */
export const passwordlessVerifySchema = verifyOtpWith({
  rememberMe: z.boolean().optional(),
});

export const resetPasswordSchema = verifyOtpWith({
  newPassword: passwordSchema,
});

/**
 * The second half of a reset for an account that holds a second factor.
 *
 * `grant` is the token `/forgot-password/reset` answered with; `option` is one
 * of the identities it listed. Neither is a credential on its own — the grant
 * proves the recovery contact and nothing else, and `option` only names which
 * factor the `code` below is for.
 */
const recoveryGrantSchema = z.object({
  grant: z.string().min(1).max(200),
  option: z.string().min(1).max(40),
});

export const recoverySecondFactorSendSchema = recoveryGrantSchema;

export const recoveryCompleteSchema = recoveryGrantSchema.extend({
  code: otpCodeSchema.or(
    // A backup code is not a six-digit OTP: `xxxxx-xxxxx` from the generated
    // set. Bounded rather than free text.
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/u, MSG_RECOVERY_CODE_INVALID)
  ),
  newPassword: passwordSchema,
});
