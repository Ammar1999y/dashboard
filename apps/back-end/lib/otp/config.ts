/**
 * The server-only half of `@app/shared/validation/otp` and `.../two-factor`.
 * Imported by `app.ts` so the gates run at assembly. Not in `lib/env.server.ts`,
 * which stays free of the validation tree (jsdom, DOMPurify).
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
  // `SMTP_FROM` is optional: `sendOtpEmail` falls back to `SMTP_USER`.
  email: ['SMTP_USER', 'SMTP_PASS'],
  sms: ['DEEWAN_SMS_TOKEN', 'DEEWAN_SENDER_NAME'],
  whatsapp: ['WHATSAPP_API_KEY'],
};

// Once, at load: per request, ahead of the IP limiter, anyone could inflate the error stream.
if (!OTP_ENABLED)
  logLine('error', {
    msg: 'otp.disabled no channel configured',
    effect: 'every OTP send and verify surface answers 404',
  });

if (!TWO_FACTOR_ENABLED)
  logLine('error', {
    msg: 'twoFactor.disabled no method configured',
    effect:
      'every two-factor and passkey surface answers 404, AND every enrolled ' +
      'account signs in with its first factor alone',
  });

// A warning, not a refusal: the reset enforces disjointness per user, and the
// configuration cannot decide it exactly.
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
 * Fatal at load: otherwise the deployment passes readiness and fails only at
 * delivery. Not gated on `OTP_AUTO_VERIFY`, which never covers passwordless,
 * recovery or 2FA codes.
 */
if (process.env.NODE_ENV === 'production') {
  const missing = [
    ...missingCredentials(ENABLED_OTP_CHANNELS, 'OTP channel'),
    ...missingCredentials(TWO_FACTOR_OTP_CHANNELS, '2FA OTP channel'),
  ];
  if (missing.length > 0) throw new Error(missingServerEnvMessage(missing));
}

// `outbox` is the test transport (`lib/otp/outbox.ts`), refused in production.
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
