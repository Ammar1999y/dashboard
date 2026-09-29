import { db } from '@/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { captcha, openAPI } from 'better-auth/plugins';

import {
  SESSION_ADDITIONAL_FIELDS,
  USER_ADDITIONAL_FIELDS,
} from '@app/shared/auth-fields';

import { PUBLIC_ORIGIN } from '@/lib/env';
import { TRUSTED_IP_HEADERS } from '@/lib/http/client-ip';

import { localiseAuthErrors } from './errors';
import { oauth } from './oauth/plugin';
import { hashPassword } from './password/hash';
import { consumePasswordProof } from './password/proof';
import { passwordless } from './passwordless';
import { enforcePathPolicy } from './path-policy';
import { reauthentication } from './reauth/plugin';
import { sessionDatabaseHooks } from './session/hooks';
import { authAdapterOptions } from './transaction';
import { twoFactorPlugins } from './two-factor/plugin';

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
      // NOT a password check — the before hook already ran the real one. This
      // only confirms that it did, for THIS request and THIS account row.
      // `PASSWORD_PROOF_PATHS` must cover every exposed library password check;
      // an omitted path fails closed because no accepted proof is minted.
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
      // Custom OAuth stores identities only; unused generic token and image columns are absent.
      validateSchema: false,
    },
    // Better Auth otherwise resolves the client IP from `x-forwarded-for`,
    // which is client-controllable whenever the origin is directly reachable.
    // Pinned to the trusted edge headers the rest of the app uses, so the IP in
    // session metadata cannot be forged. IPv6 is bucketed by /64, matching
    // `ipBucket`. The development fallback in `getClientIp` does NOT apply:
    // Better Auth reads the headers itself, so it resolves no IP locally.
    //
    // TODO(proxy-trust): the header is trusted on syntax alone — see
    // `TRUSTED_IP_HEADERS` in `lib/http/client-ip.ts`.
    ipAddress: {
      ipAddressHeaders: [...TRUSTED_IP_HEADERS],
      ipv6Subnet: 64,
    },
  },

  logger: {
    disabled: true,
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
  // The adapter resolves a model as `schema[modelName]`, so this string and the
  // export in `db/schema.ts` must stay identical.
  verification: {
    modelName: 'verifications',
  },

  plugins: [
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey:
        process.env.NODE_ENV === 'development'
          ? '1x0000000000000000000000000000000AA'
          : (process.env.TURNSTILE_SECRET_KEY ?? ''),
      // Matched EXACTLY against the path with the base path stripped: an entry
      // covers one path, so `'/sign-in'` protects nothing and a prefix has to
      // be written `'/sign-in/*'`.
      // TODO: add the proper endpoints — and write each one in full.
      endpoints: ['/sign-in/email'],
    }),
    passwordless(),
    oauth(),
    reauthentication(),
    // Empty unless a method is configured.
    ...twoFactorPlugins,
    openAPI({ disableDefaultReference: true }),
  ],
});
