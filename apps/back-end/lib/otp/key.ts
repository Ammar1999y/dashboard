/**
 * Not the password pepper, deliberately: an OTP generation may be dropped once
 * no unexpired code uses it, a pepper generation only once no hash does.
 */
import { defineKeyring } from '@/lib/auth/keyring';

const keyring = defineKeyring({
  activeIdEnv: 'OTP_HMAC_ACTIVE_ID',
  keyringEnv: 'OTP_HMAC_KEYRING',
  label: 'OTP MAC',
});

export function validateOtpKeyConfiguration(): void {
  keyring.validate();
}

export const getActiveOtpKey = keyring.active;
export const getOtpKey = keyring.byId;
