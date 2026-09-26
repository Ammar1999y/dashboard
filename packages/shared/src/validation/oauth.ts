import * as z from 'zod';

/** `POST /api/auth/oauth/google/start`. */
export const googleStartSchema = z
  .object({
    mode: z.literal('sign_in').default('sign_in'),
    callbackURL: z.string().min(1).max(2048).optional(),
    rememberMe: z.boolean().optional(),
  })
  .strict();
