import * as z from 'zod';

/** Every provider this server can sign in with; which are enabled is server configuration. */
export const OAUTH_PROVIDERS = ['google'] as const;

/**
 * Where the Google callback sends a browser whose sign-in state it cannot read
 * (expired, or started in another browser): the flow's `callbackURL` is inside
 * that state. The sign-in page must answer this query with a start-again message.
 */
export const OAUTH_STATE_LOST_PAGE = '/dash/sign-in?oauth=expired';

/** `POST /api/auth/oauth/google/start`. */
export const googleStartSchema = z
  .object({
    mode: z.literal('sign_in').default('sign_in'),
    callbackURL: z.string().min(1).max(2048).optional(),
    rememberMe: z.boolean().optional(),
  })
  .strict();
