/**
 * The OTP MAC keyring behind `./hash.ts`. Parsing and validation live in
 * `@/lib/auth/keyring`; this is only the binding to these two variable names.
 *
 * Deliberately not the password pepper: the lifecycles differ. An OTP key
 * generation may be dropped once no unexpired code was issued under it —
 * `OTP_EXPIRY_MINUTES` plus a margin after it stops being active — whereas a
 * pepper generation must outlive every hash carrying its id. One shared keyring
 * would tie each retirement to the other's horizon.
 */
import { defineKeyring } from '@/lib/auth/keyring';

const keyring = defineKeyring({
  activeIdEnv: 'OTP_HMAC_ACTIVE_ID',
  keyringEnv: 'OTP_HMAC_KEYRING',
  label: 'OTP MAC',
});

/** Forces the parse at startup so a misconfiguration crashes the boot, not a send. */
export function validateOtpKeyConfiguration(): void {
  keyring.validate();
}

export const getActiveOtpKey = keyring.active;
export const getOtpKey = keyring.byId;
