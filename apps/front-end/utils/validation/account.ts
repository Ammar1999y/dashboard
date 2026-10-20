import * as z from 'zod';
import { MSG_NAME_TOO_LONG } from '@app/shared/messages/validation';
import {
  changeEmailSchema,
  changePasswordSchema,
  changePhoneSchema,
  selfUpdateUserBodySchema,
} from '@app/shared/validation/auth';
import { NAME_MAX } from '@app/shared/validation/constants';
import { reauthPasswordSchema } from '@app/shared/validation/rules';

import { captchaField } from './auth';

// The server's own body schemas, with what a form adds: a captcha field
// wherever the route verifies one, and an empty current password read as none.

export type RenameInput = z.input<typeof selfUpdateUserBodySchema>;
export type RenameOutput = z.output<typeof selfUpdateUserBodySchema>;

/**
 * The server takes the current password or an open re-authentication window.
 * Left empty, a closed window opens the prompt, and the captcha the attempt
 * spent makes the form ask for a second submit.
 */
const currentPassword = z.preprocess(
  (value: string) => (value === '' ? undefined : value),
  reauthPasswordSchema
);

const proof = { currentPassword, ...captchaField };

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
