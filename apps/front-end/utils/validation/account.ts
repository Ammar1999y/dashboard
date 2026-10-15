import * as z from 'zod';
import { MSG_NAME_TOO_LONG } from '@app/shared/messages/validation';
import {
  changeEmailSchema,
  changePasswordSchema,
  changePhoneSchema,
  selfUpdateUserBodySchema,
} from '@app/shared/validation/auth';
import { NAME_MAX } from '@app/shared/validation/constants';
import { passwordSchema } from '@app/shared/validation/rules';

import { captchaField } from './auth';

// The server's own body schemas, with what a form adds: the current password
// is asked for in full, because the captcha token in the same request is
// spent by the first attempt and cannot ride a retry after a re-authentication
// prompt; and a captcha field wherever the route verifies one.

export type RenameInput = z.input<typeof selfUpdateUserBodySchema>;
export type RenameOutput = z.output<typeof selfUpdateUserBodySchema>;

const proof = { currentPassword: passwordSchema, ...captchaField };

export const changeEmailFormSchema = changeEmailSchema.extend(proof);
export type ChangeEmailInput = z.input<typeof changeEmailFormSchema>;
export type ChangeEmailOutput = z.output<typeof changeEmailFormSchema>;

export const changePhoneFormSchema = changePhoneSchema.extend(proof);
export type ChangePhoneInput = z.input<typeof changePhoneFormSchema>;
export type ChangePhoneOutput = z.output<typeof changePhoneFormSchema>;

export const changePasswordFormSchema = changePasswordSchema.extend(proof);
export type ChangePasswordInput = z.input<typeof changePasswordFormSchema>;
export type ChangePasswordOutput = z.output<typeof changePasswordFormSchema>;

/** A passkey's name is optional: left empty, the account lists it unnamed. */
export const passkeyNameFormSchema = z.object({
  name: z.string().trim().max(NAME_MAX, MSG_NAME_TOO_LONG),
});
export type PasskeyNameInput = z.input<typeof passkeyNameFormSchema>;
export type PasskeyNameOutput = z.output<typeof passkeyNameFormSchema>;
