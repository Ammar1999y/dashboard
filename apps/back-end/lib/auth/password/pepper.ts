/**
 * The password pepper keyring: a server-side secret mixed into every Argon2id
 * password hash, so a stolen database alone cannot be attacked offline. Parsing
 * and validation live in `../keyring.ts`; this is only the binding to these two
 * variable names.
 *
 * **Retirement rule.** Removing a generation makes every hash still carrying its
 * id unverifiable, and `verifyPasswordDetailed` turns that into an ordinary
 * failed login — working passwords refused, reported only as
 * `auth.password.hash unevaluatable` in the log. Startup validation cannot see
 * it: which generations are in use is a property of the stored rows. Keep a
 * generation until every hash has been rehashed under a newer one (`needsRehash`).
 * The OTP keyring has the same rule with a shorter horizon (`lib/otp/key.ts`).
 */
import { defineKeyring } from '../keyring';

const keyring = defineKeyring({
  activeIdEnv: 'PASSWORD_PEPPER_ACTIVE_ID',
  keyringEnv: 'PASSWORD_PEPPER_KEYRING',
  label: 'password pepper',
});

/** Forces the parse at startup so a misconfiguration crashes the boot, not a login. */
export function validatePasswordPepperConfiguration(): void {
  keyring.validate();
}

export const getActivePasswordPepper = keyring.active;
export const getPasswordPepper = keyring.byId;
