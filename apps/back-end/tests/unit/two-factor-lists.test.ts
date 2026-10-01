/**
 * `assertTwoFactorListsCoherent` — the rule the server refuses to boot on,
 * shared with `scripts/check-two-factor-rollout.ts`.
 *
 * It lived only in `validation/two-factor.ts`'s load-time throw, so the
 * preflight certified `totp,otp` with no channel, and `sms` alone on a
 * deployment without phones, and the deploy then failed to boot.
 */
import { describe, expect, test } from 'bun:test';

import {
  assertTwoFactorListsCoherent,
  parseTwoFactorMethods,
  parseTwoFactorOtpChannels,
  TWO_FACTOR_OTP_CHANNELS_VAR,
} from '@app/shared/validation/two-factor-lists';

describe('the otp-needs-a-channel rule', () => {
  test('refuses otp with no channel, naming the variable to set', () => {
    expect(() =>
      assertTwoFactorListsCoherent(
        parseTwoFactorMethods('totp,otp'),
        parseTwoFactorOtpChannels(undefined)
      )
    ).toThrow(`names no channel`);
    expect(() => assertTwoFactorListsCoherent(['otp'], [])).toThrow(
      TWO_FACTOR_OTP_CHANNELS_VAR
    );
  });

  test('accepts otp with a channel, and any list without otp', () => {
    expect(() =>
      assertTwoFactorListsCoherent(['totp', 'otp'], ['email'])
    ).not.toThrow();
    expect(() =>
      assertTwoFactorListsCoherent(['totp', 'backup_code'], [])
    ).not.toThrow();
    expect(() => assertTwoFactorListsCoherent([], [])).not.toThrow();
  });
});
