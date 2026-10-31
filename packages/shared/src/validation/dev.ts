import * as z from 'zod';

import { emailSchema, passwordSchema } from './rules';
import { selfUpdateUserBodySchema } from './users';

/** `POST /api/dev/sign-up`, a route production does not register. */
export const devSignUpSchema = z.object({
  name: selfUpdateUserBodySchema.shape.name,
  email: emailSchema,
  password: passwordSchema,
});
