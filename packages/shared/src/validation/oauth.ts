import * as z from 'zod';

/** Every provider this server can sign in with; which are enabled is server configuration. */
export const OAUTH_PROVIDERS = ['google'] as const;

/** `POST /api/auth/oauth/google/start`. */
export const googleStartSchema = z
  .object({
    mode: z.literal('sign_in').default('sign_in'),
    callbackURL: z.string().min(1).max(2048).optional(),
    rememberMe: z.boolean().optional(),
  })
  .strict();
