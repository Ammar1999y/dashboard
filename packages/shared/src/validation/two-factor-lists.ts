/**
 * The two public two-factor lists, parsed from a value the caller hands in.
 *
 * ⚠️ No environment reads, here or in anything imported:
 * `scripts/check-two-factor-rollout.ts` judges a PROPOSED configuration with
 * these, and must not trip over the current one.
 */
import type { OtpChannel, TwoFactorMethod } from './enums';

import { OTP_CHANNELS, TWO_FACTOR_METHODS } from './enums';
import { parseEnumList } from './env-list';

export const TWO_FACTOR_METHODS_VAR = 'NEXT_PUBLIC_ENABLED_2FA_METHODS';
export const TWO_FACTOR_OTP_CHANNELS_VAR =
  'NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS';

export function parseTwoFactorMethods(
  value: string | undefined
): TwoFactorMethod[] {
  return parseEnumList(value, {
    name: TWO_FACTOR_METHODS_VAR,
    allowed: TWO_FACTOR_METHODS,
    noun: 'method',
    unsetMeans: 'disable two-factor authentication entirely',
  });
}

/** Before the `PHONE_ENABLED` filter, which each caller applies itself. */
export function parseTwoFactorOtpChannels(
  value: string | undefined
): OtpChannel[] {
  return parseEnumList(value, {
    name: TWO_FACTOR_OTP_CHANNELS_VAR,
    allowed: OTP_CHANNELS,
    noun: 'channel',
    unsetMeans: 'disable the OTP second factor',
  });
}
