import * as z from 'zod';

import { selfUpdateUserBodySchema } from './auth';
import { emailSchema, passwordSchema } from './rules';

/** `POST /api/dev/sign-up`, a route production does not register. */
export const devSignUpSchema = z.object({
  name: selfUpdateUserBodySchema.shape.name,
  email: emailSchema,
  password: passwordSchema,
});
