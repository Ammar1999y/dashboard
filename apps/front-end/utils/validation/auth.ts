import type { UserClient } from '@/types/user';
import type {
  adminUpdateUserBodySchema,
  createUserSchema,
} from '@app/shared/validation/auth';
import type { devSignUpSchema } from '@app/shared/validation/dev';
import type { DefaultValues } from 'react-hook-form';

import * as z from 'zod';
import { PHONE_ENABLED } from '@app/shared/config';
import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { loginSchema } from '@app/shared/validation/auth';
import { otpCodeSchema } from '@app/shared/validation/otp';

export type LoginInput = z.input<typeof loginSchema>;
export type LoginOutput = z.output<typeof loginSchema>;

/**
 * The `captcha` field of a form whose request needs a token. The server reads
 * the token from a header, so only the sign-in body schema carries it; any
 * other form spreads this into its own schema, beside the widget in
 * `components/dash/auth/turnstile`.
 */
export const captchaField = { captcha: loginSchema.shape.captcha };

/** The code of a verification, on its own. */
export const codeFormSchema = z.object({ code: otpCodeSchema });
export type CodeInput = z.input<typeof codeFormSchema>;
export type CodeOutput = z.output<typeof codeFormSchema>;

/** A code whose route also verifies a captcha. */
export const codeCaptchaFormSchema = codeFormSchema.extend(captchaField);
export type CodeCaptchaInput = z.input<typeof codeCaptchaFormSchema>;
export type CodeCaptchaOutput = z.output<typeof codeCaptchaFormSchema>;

export type DevSignUpInput = z.input<typeof devSignUpSchema>;
export type DevSignUpOutput = z.output<typeof devSignUpSchema>;

export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserInput = z.input<typeof adminUpdateUserBodySchema>;
export type CreateUserOutput = z.output<typeof createUserSchema>;
export type UpdateUserOutput = z.output<typeof adminUpdateUserBodySchema>;

/** See the note on DEFAULT_PERMISSION in ./permissions. */
export const DEFAULT_USER: DefaultValues<CreateUserInput> = {
  name: '',
  email: '',
  password: '',
  phoneNumber: '',
  isActive: true,
  roleId: undefined,
  permissions: undefined,
};

/**
 * See the note on toPermissionForm in ./permissions. The password is never seeded
 * from a record — the API does not return one, and an empty field is what the
 * update schema reads as "leave it alone".
 */
export const toUserForm = (record: UserClient): UpdateUserInput => ({
  name: record.name,
  email: record.email,
  password: '',
  // The schema refuses a number while the deployment serves none, and the
  // field that would clear it is not on the form.
  phoneNumber: PHONE_ENABLED ? (record.phoneNumber ?? '') : '',
  isActive: record.isActive,
  // A user whose role was deleted comes back with `roleId: null`; the empty
  // string keeps the select on its placeholder and lets the schema ask for a
  // real one at submit, which `null` (a valid-looking value) would not.
  roleId: record.roleId ?? '',
  // The API sends every user's effective permissions, but the form carries a
  // matrix only for a custom role — the schema rejects one on any other.
  permissions:
    record.roleId === CUSTOM_ROLE_VALUE ? record.permissions : undefined,
});
