import * as z from 'zod';

import { NAME_MAX } from './constants';
import { emailSchema, passwordSchema } from './rules';

/** `POST /api/dev/sign-up`, a route the production route table withholds. */
export const devSignUpSchema = z.object({
  name: z
    .string()
    .min(2, 'الاسم مطلوب')
    .max(NAME_MAX, `الاسم يجب أن لا يتجاوز ${NAME_MAX} حرفاً`),
  email: emailSchema,
  password: passwordSchema,
});
