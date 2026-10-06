import { db } from '@/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { captcha, openAPI } from 'better-auth/plugins';

import {
  SESSION_ADDITIONAL_FIELDS,
  USER_ADDITIONAL_FIELDS,
} from '@app/shared/auth-fields';

import { turnstileSecretKey } from '@/lib/captcha';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { TRUSTED_IP_HEADERS } from '@/lib/http/client-ip';

import { logSanitized } from '@/utils/log';

import { localiseAuthErrors } from './errors';
import { oauth } from './oauth/plugin';
import { hashPassword } from './password/hash';
import { consumePasswordProof } from './password/proof';
import { passwordless } from './passwordless';
import { enforcePathPolicy } from './path-policy';
import { reauthentication } from './reauth/plugin';
import { sessionCookieCache } from './session/cookie-cache';
import { sessionDatabaseHooks } from './session/hooks';
import { authAdapterOptions } from './transaction';
import { twoFactorPlugins } from './two-factor/plugin';

/**
 * Refusals the library logs at `error` with the caller's text and no code, so
 * only the prefix identifies them: the origin and CSRF checks
 * (`better-auth/dist/api/middlewares/origin-check.mjs`).
 */
const CLIENT_REFUSAL_PREFIXES = [
  'Invalid origin:',
  'Invalid callbackURL:',
  'Invalid redirectURL:',
  'Invalid errorCallbackURL:',
  'Invalid newUserCallbackURL:',
  'Blocked cross-site navigation login attempt',
] as const;

function isClientRefusal(message: string): boolean {
  return CLIENT_REFUSAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export const auth = betterAuth({
  // The parsed value, not the environment variable: the CORS allow-list entry
  // and the origin cookies are signed against must be the same string.
  baseURL: PUBLIC_ORIGIN,
  database: drizzleAdapter(db, authAdapterOptions),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    password: {
      hash: hashPassword,
      // NOT a password check: it confirms the `before` hook ran the real one
      // for this request and account row. See `PASSWORD_PROOF_PATHS`.
      verify: async ({ hash, password }) =>
        consumePasswordProof(hash, password),
    },
  },

  hooks: {
    before: createAuthMiddleware(enforcePathPolicy),
    after: createAuthMiddleware(localiseAuthErrors),
  },

  advanced: {
    database: {
      generateId: false,
      // Without it the adapter's fallback join `console.error`s a failed query
      // raw, bound parameters included. Needs the relation keys in `db/schema.ts`.
      joins: true,
      // Custom OAuth stores identities only; unused generic token and image columns are absent.
      validateSchema: false,
    },
    // Otherwise `x-forwarded-for`, which a client controls. The subnet matches
    // `ipBucket`; `getClientIp`'s development fallback does not apply here.
    //
    // TODO(proxy-trust): the header is trusted on syntax alone — see
    // `TRUSTED_IP_HEADERS` in `lib/http/client-ip.ts`.
    ipAddress: {
      ipAddressHeaders: [...TRUSTED_IP_HEADERS],
      ipv6Subnet: 64,
    },
  },

  logger: {
    // `warn` is per-request client-failure chatter (`User not found`,
    // `Invalid password`). `error` still carries some caller-triggered
    // refusals, which `log` demotes (`isClientRefusal`).
    level: 'error',
    log: (level, message, ...args: unknown[]) => {
      logSanitized(
        level === 'debug' || level === 'info'
          ? 'log'
          : isClientRefusal(message)
            ? 'warn'
            : level,
        { msg: 'betterAuth', message, args }
      );
    },
  },
  // Anything but an `APIError` reaches `app.ts`'s catch and `logSanitized`;
  // Better Call would otherwise print it raw, bound query parameters included.
  onAPIError: {
    throw: true,
  },

  session: {
    expiresIn: 28 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    cookieCache: {
      enabled: true,
      // TODO: set from the deployment's security policy.
      maxAge: 5 * 60,
    },
    additionalFields: SESSION_ADDITIONAL_FIELDS,
    modelName: 'sessions',
  },
  databaseHooks: {
    session: sessionDatabaseHooks,
  },

  rateLimit: {
    enabled: false,
  },

  user: {
    modelName: 'users',
    additionalFields: USER_ADDITIONAL_FIELDS,
  },
  account: {
    modelName: 'accounts',
    accountLinking: { enabled: false },
  },
  // Must equal the `db/schema.ts` export name: the adapter resolves `schema[modelName]`.
  verification: {
    modelName: 'verifications',
  },

  plugins: [
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey: turnstileSecretKey() ?? '',
      // Exact match: `'/sign-in'` protects nothing; a prefix is `'/sign-in/*'`.
      // TODO: add the proper endpoints — and write each one in full.
      endpoints: ['/sign-in/email'],
    }),
    passwordless(),
    oauth(),
    reauthentication(),
    // Empty unless a method is configured.
    ...twoFactorPlugins,
    sessionCookieCache(),
    openAPI({ disableDefaultReference: true }),
  ],
});
