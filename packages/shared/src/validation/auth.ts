import * as z from 'zod';

import { MSG_CAPTCHA_REQUIRED } from '../messages/validation';
import { emailSchema, passwordSchema } from './rules';

export const CAPTCHA_HEADER = 'x-captcha-response';
export const CAPTCHA_TOKEN_MAX_LENGTH = 2048;

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  captcha: z
    .string()
    .min(1, MSG_CAPTCHA_REQUIRED)
    .max(CAPTCHA_TOKEN_MAX_LENGTH, MSG_CAPTCHA_REQUIRED),
  // Validated and published rather than read straight off the body: the value
  // decides a session lifetime, and it survives a two-factor challenge in the
  // companion record. `HONOUR_REMEMBER_ME` decides whether it is obeyed.
  rememberMe: z.boolean().optional(),
});
