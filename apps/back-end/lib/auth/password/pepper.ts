/**
 * ⚠️ Retirement: removing a generation still carried by a stored hash refuses
 * that working password, logged only as `auth.password.hash unevaluatable`;
 * startup cannot see it. Keep a generation until every hash is rehashed.
 */
import { defineKeyring } from '../keyring';

const keyring = defineKeyring({
  activeIdEnv: 'PASSWORD_PEPPER_ACTIVE_ID',
  keyringEnv: 'PASSWORD_PEPPER_KEYRING',
  label: 'password pepper',
});

export function validatePasswordPepperConfiguration(): void {
  keyring.validate();
}

export const getActivePasswordPepper = keyring.active;
export const getPasswordPepper = keyring.byId;
