/**
 * Better Auth's own endpoints this client calls through `api()`. Their bodies
 * are the library's, which the server neither publishes as its own nor
 * checks, so each `raw` is only what this client reads: zod drops the rest.
 * Sign-in, sign-out and the session stay on the auth client.
 */
import * as z from 'zod';
import { endpoint } from '@app/shared/api/endpoint';
import { passkeyGrantSchema } from '@app/shared/validation/two-factor';
import { passkeysSchema } from '@/lib/account/schemas';

/** A two-factor challenge cookie, or a session, and nothing else. */
const POLICY = {
  auth: 'public',
  captcha: false,
  reauth: false,
  rateLimited: true,
  checksPassword: false,
} as const;

const SESSION = { ...POLICY, auth: 'session' } as const;

/** What a verifier's success is read for: the session it opened. */
export const signedInSchema = z.object({ user: z.object({ id: z.string() }) });

const codeBodySchema = z.object({ code: z.string() });

export const verifyTotp = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/verify-totp',
  body: codeBodySchema,
  status: 200,
  response: { raw: signedInSchema },
  policy: POLICY,
  changesSession: true,
});

export const verifyBackupCode = endpoint({
  method: 'POST',
  path: '/api/auth/two-factor/verify-backup-code',
  body: codeBodySchema,
  status: 200,
  response: { raw: signedInSchema },
  policy: POLICY,
  changesSession: true,
});

/**
 * Handed to the browser's ceremony as they came; only what it cannot start
 * without is checked here, and the browser rejects a malformed rest.
 */
export const passkeyCreationOptionsSchema = z.looseObject({
  challenge: z.string().min(1),
  rp: z.looseObject({ name: z.string() }),
  user: z.looseObject({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
  }),
  pubKeyCredParams: z.array(
    z.looseObject({ type: z.literal('public-key'), alg: z.number() })
  ),
});

export const passkeyRegistrationOptions = endpoint({
  method: 'GET',
  path: '/api/auth/passkey/generate-register-options',
  query: z.object({ name: z.string().optional() }),
  status: 200,
  response: { raw: passkeyCreationOptionsSchema },
  policy: SESSION,
});

/** Spends the grant `/two-factor/passkey/grant` answered. */
export const verifyPasskeyRegistration = endpoint({
  method: 'POST',
  path: '/api/auth/passkey/verify-registration',
  body: z.object({
    response: z.record(z.string(), z.unknown()),
    name: z.string().optional(),
    grant: passkeyGrantSchema,
  }),
  status: 200,
  response: { raw: z.object({ id: z.string() }) },
  policy: SESSION,
});

export const listPasskeys = endpoint({
  method: 'GET',
  path: '/api/auth/passkey/list-user-passkeys',
  status: 200,
  response: { raw: passkeysSchema },
  policy: SESSION,
});
