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

/**
 * The coherence rule between the two lists: `otp` with no channel would be
 * advertised in settings, enabled by users, and then fail to deliver at their
 * next sign-in, with no session left to fix it from.
 *
 * ⚠️ `channels` is the list AFTER the `PHONE_ENABLED` filter; checked before it,
 * `sms` alone on a deployment without phones passes and the server then refuses
 * to boot.
 */
export function assertTwoFactorListsCoherent(
  methods: readonly TwoFactorMethod[],
  channels: readonly OtpChannel[]
): void {
  if (methods.includes('otp') && channels.length === 0)
    throw new Error(
      `${TWO_FACTOR_METHODS_VAR} enables "otp" but ${TWO_FACTOR_OTP_CHANNELS_VAR} names no channel. ` +
        `Set ${TWO_FACTOR_OTP_CHANNELS_VAR} to a comma-separated list of ${OTP_CHANNELS.join(', ')}, ` +
        `or remove "otp" from ${TWO_FACTOR_METHODS_VAR}.`
    );
}
