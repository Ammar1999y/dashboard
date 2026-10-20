import type { TwoFactorOption } from '../schemas';
import type { IconName } from '@/components/ui/icon';

import { completePasswordReset } from '@app/shared/api/auth';
import {
  isTwoFactorMethodEnabled,
  isTwoFactorOtpChannelEnabled,
} from '@app/shared/validation/two-factor';
import {
  MSG_TWO_FACTOR_BACKUP_CODE,
  MSG_TWO_FACTOR_OTP_EMAIL,
  MSG_TWO_FACTOR_OTP_PHONE,
  MSG_TWO_FACTOR_PASSKEY,
  MSG_TWO_FACTOR_TOTP,
} from '@/constants/messages';

/** A way to prove a second factor; `nextAllowedIn` is only there at sign-in. */
export type FactorOption = TwoFactorOption;

/**
 * What this deployment's own switches still allow of what the server offered:
 * a method or channel it has turned off is not shown, and nothing is left to
 * show when every offered option is one of those.
 */
export function usableOptions<T extends FactorOption>(
  options: readonly T[]
): T[] {
  return options.filter(
    ({ method, channel }) =>
      isTwoFactorMethodEnabled(method) &&
      (method !== 'otp' ||
        (channel !== null && isTwoFactorOtpChannelEnabled(channel)))
  );
}

/** A backup code or a six-digit code: the recovery schema's rule for what it accepts. */
export const backupCodeSchema = completePasswordReset.body.shape.code;

export function optionLabel({ method, contactKind }: FactorOption) {
  switch (method) {
    case 'totp': {
      return 'تطبيق المصادقة';
    }
    case 'passkey': {
      return 'مفتاح المرور';
    }
    case 'backup_code': {
      return 'رمز احتياطي';
    }
    case 'otp': {
      return contactKind === 'phone'
        ? 'رمز إلى الهاتف'
        : 'رمز إلى البريد الإلكتروني';
    }
  }
}

export function optionHint({ method, contactKind }: FactorOption) {
  switch (method) {
    case 'totp': {
      return MSG_TWO_FACTOR_TOTP;
    }
    case 'passkey': {
      return MSG_TWO_FACTOR_PASSKEY;
    }
    case 'backup_code': {
      return MSG_TWO_FACTOR_BACKUP_CODE;
    }
    case 'otp': {
      return contactKind === 'phone'
        ? MSG_TWO_FACTOR_OTP_PHONE
        : MSG_TWO_FACTOR_OTP_EMAIL;
    }
  }
}

export function optionIcon({ method, contactKind }: FactorOption): IconName {
  switch (method) {
    case 'totp': {
      return 'solar:shield-keyhole-bold-duotone';
    }
    case 'passkey': {
      return 'solar:key-square-2-bold-duotone';
    }
    case 'backup_code': {
      return 'solar:document-text-bold-duotone';
    }
    case 'otp': {
      return contactKind === 'phone'
        ? 'solar:smartphone-bold-duotone'
        : 'solar:letter-bold-duotone';
    }
  }
}
