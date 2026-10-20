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

/** `generateState`'s token: 32 of `generateRandomString`'s `a-z0-9A-Z-_`. */
const OAUTH_STATE_PATTERN = /^[\w-]{32}$/;

/** `GET /api/auth/oauth/google/callback`, the query Google redirects the browser with. */
export const googleCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  // `generateState`'s own shape. Not proof the state is ours: the server
  // checks its marker.
  state: z.string().regex(OAUTH_STATE_PATTERN),
  error: z.string().max(256).optional(),
  iss: z.string().max(255).optional(),
});
