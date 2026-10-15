import { fieldDocs, schemaDocs } from '../api/field-docs';
import { removedMethodSchema, twoFactorChallengeSchema } from './better-auth';

export const docs = [
  schemaDocs(
    twoFactorChallengeSchema,
    'The first factor succeeded and the login is NOT complete: no session cookie is set, and one of the options below has to be verified next.'
  ),
  fieldDocs(twoFactorChallengeSchema, {
    twoFactorMethods:
      'Distinct method names. Two OTP channels collapse into one entry here, so it cannot drive a choice — use `twoFactorOptions`.',
    defaultMethod:
      '`null` means ask: only recovery material is left, and a backup code is never auto-routed to.',
  }),
  fieldDocs(twoFactorChallengeSchema.shape.twoFactorOptions.element, {
    id: 'Stable option identity: `totp`, `backup_code`, `passkey`, `otp:email` or `otp:phone`.',
    nextAllowedIn:
      '`otp` options only: seconds before a code may be sent to this contact. `0` means a send is allowed now.',
  }),
  fieldDocs(removedMethodSchema, {
    removedMethod:
      'The option that is gone, `otp:email` / `otp:phone` / `totp` / `backup_code` / `passkey`.',
  }),
];
