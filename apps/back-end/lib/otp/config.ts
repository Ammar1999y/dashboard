/**
 * The server half of the OTP and two-factor configuration.
 *
 * The enabled channels and methods are derived in `@app/shared/validation/otp`
 * and `.../two-factor`, which the browser bundle also runs. Everything here
 * needs what that bundle must never see or do: provider credentials, the
 * delivery mode, and a process that refuses to start or writes an operator
 * notice at load.
 *
 * Imported by `app.ts` so the gates run when the application is assembled, not
 * when some handler happens to import a sender. Not folded into
 * `lib/env.server.ts`: that module stays free of the validation tree (jsdom and
 * DOMPurify) so the per-case env-secret probes remain cheap.
 */
import type { OtpChannel } from '@app/shared/validation/enums';

import { contactKindOf } from '@app/shared/validation/enums';
import {
  EMAIL_OTP_AVAILABLE,
  ENABLED_OTP_CHANNELS,
  OTP_ENABLED,
  PHONE_OTP_AVAILABLE,
} from '@app/shared/validation/otp';
import {
  ENABLED_TWO_FACTOR_METHODS,
  isTwoFactorMethodEnabled,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_CHANNELS,
} from '@app/shared/validation/two-factor';
import {
  TWO_FACTOR_METHODS_VAR,
  TWO_FACTOR_OTP_CHANNELS_VAR,
} from '@app/shared/validation/two-factor-lists';

import { logLine } from '@/utils/log';
import { missingServerEnvMessage } from '@/utils/missing-env';

/** Read at send time in `./delivery.ts`; required here at startup. */
const CHANNEL_CREDENTIALS: Readonly<Record<OtpChannel, readonly string[]>> = {
  // `SMTP_FROM` is optional: `sendOtpEmail` falls back to `SMTP_USER` as the
  // sender, so `SMTP_USER` covers both the login and the envelope.
  email: ['SMTP_USER', 'SMTP_PASS'],
  sms: ['DEEWAN_SMS_TOKEN', 'DEEWAN_SENDER_NAME'],
  whatsapp: ['WHATSAPP_API_KEY'],
};

/**
 * Logged ONCE, at load, because it is a deploy fault: with OTP off every
 * recovery and passwordless request answers 404, indistinguishable in an access
 * log from an unrouted path. Never per request — ahead of the IP limiter, that
 * would let anyone inflate the error stream whenever OTP is intentionally off.
 */
if (!OTP_ENABLED)
  logLine('error', {
    msg: 'otp.disabled no channel configured',
    effect: 'every OTP send and verify surface answers 404',
  });

/**
 * Logged once, and it says the part an operator does not expect: an empty list
 * does not only hide the surfaces, it stops ENFORCEMENT for accounts that
 * already hold `two_factor_enabled`. They sign in with the password alone until
 * a method is configured again.
 */
if (!TWO_FACTOR_ENABLED)
  logLine('error', {
    msg: 'twoFactor.disabled no method configured',
    effect:
      'every two-factor and passkey surface answers 404, AND every enrolled ' +
      'account signs in with its first factor alone',
  });

/**
 * A WARNING, not a refusal. Disjointness is enforced by the authentication
 * CHAIN: the reset proves a second factor from a set that excludes the contact
 * its own code arrived on, and refuses when nothing survives that exclusion.
 * The configuration cannot decide it exactly, so refusing to boot would make a
 * supported deployment unstartable.
 */
const overlappingKinds = TWO_FACTOR_OTP_CHANNELS.filter((channel) =>
  contactKindOf(channel) === 'email' ? EMAIL_OTP_AVAILABLE : PHONE_OTP_AVAILABLE
);
if (
  ENABLED_TWO_FACTOR_METHODS.length === 1 &&
  isTwoFactorMethodEnabled('otp') &&
  TWO_FACTOR_OTP_CHANNELS.length > 0 &&
  overlappingKinds.length === TWO_FACTOR_OTP_CHANNELS.length
)
  logLine('error', {
    msg: 'twoFactor.otpOverlapsRecovery',
    methods: [...ENABLED_TWO_FACTOR_METHODS],
    otpChannels: [...TWO_FACTOR_OTP_CHANNELS],
    effect:
      'every second factor reaches a contact account recovery also reaches, ' +
      'so password recovery will refuse for these users and the administrative ' +
      'reset is their only route back',
    remedy: `add "totp", "backup_code" or "passkey" to ${TWO_FACTOR_METHODS_VAR}, or point ${TWO_FACTOR_OTP_CHANNELS_VAR} at a contact kind recovery does not use`,
  });

function missingCredentials(
  channels: readonly OtpChannel[],
  role: string
): string[] {
  return channels.flatMap((channel) =>
    CHANNEL_CREDENTIALS[channel]
      .filter((name) => !process.env[name]?.trim())
      .map((name) => `${name} (required by the "${channel}" ${role})`)
  );
}

/**
 * Every ENABLED channel must have its provider credentials, in production.
 *
 * Fatal at load, like the production-only requirements in `lib/env.server.ts`,
 * because the failure is otherwise invisible until a real user needs it: the
 * deployment starts, passes readiness, and accepts and persists every send
 * before delivery fails — leaving recovery and passwordless login unusable.
 *
 * Not gated on `OTP_AUTO_VERIFY`: that bypass never reaches
 * `passwordless_login` or `forgot_password`, both of which always issue a real
 * code, so a channel that is enabled still has to be deliverable — and a second
 * factor that can be skipped is not one, so the 2FA channels always need a real
 * provider.
 *
 * Production only — a developer running with `OTP_AUTO_VERIFY` and no mail
 * provider is a supported local configuration.
 */
if (process.env.NODE_ENV === 'production') {
  const missing = [
    ...missingCredentials(ENABLED_OTP_CHANNELS, 'OTP channel'),
    ...missingCredentials(TWO_FACTOR_OTP_CHANNELS, '2FA OTP channel'),
  ];
  if (missing.length > 0) throw new Error(missingServerEnvMessage(missing));
}

/**
 * Where a code goes: the channel's provider, or — for a test process — an
 * in-memory outbox the test reads back (`lib/otp/outbox.ts`). A channel can
 * then be exercised end to end, and the delivered text asserted, with no
 * provider account.
 *
 * Refused in production at load: a deployment set to `outbox` would accept every
 * send and deliver nothing, which is the failure the credential gate above exists
 * to prevent.
 */
const OTP_DELIVERY_MODES = ['provider', 'outbox'] as const;
const otpDelivery = process.env.OTP_DELIVERY?.trim() || 'provider';
if (!(OTP_DELIVERY_MODES as readonly string[]).includes(otpDelivery))
  throw new Error(
    `OTP_DELIVERY must be one of ${OTP_DELIVERY_MODES.join(', ')}; got "${otpDelivery}"`
  );
export const OTP_DELIVERY_OUTBOX = otpDelivery === 'outbox';
if (OTP_DELIVERY_OUTBOX && process.env.NODE_ENV === 'production')
  throw new Error(
    'OTP_DELIVERY=outbox is a test transport: no code would ever reach a user. Unset it in production.'
  );
