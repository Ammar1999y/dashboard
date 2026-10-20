import type { RoutePrefix, RoutePrefixPath } from '@/lib/http/routing';

import { BETTER_AUTH_PREFIX } from '@app/shared/api/endpoint';
import { PASSWORDLESS_ENABLED } from '@app/shared/config';
import { OTP_ENABLED } from '@app/shared/validation/otp';
import {
  isTwoFactorMethodEnabled,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_AVAILABLE,
} from '@app/shared/validation/two-factor';

import { GOOGLE_ENABLED } from './oauth/config';

interface EndpointGroup {
  enabled: boolean;
  endpoints: readonly RoutePrefixPath[];
}

/** Row order is `BETTER_AUTH_ENDPOINTS`' order. */
const ENDPOINT_GROUPS: readonly EndpointGroup[] = [
  {
    enabled: true,
    endpoints: [
      {
        path: '/capabilities',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
        session: 'none',
      },
      {
        path: '/reauth/methods',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
        session: 'session',
      },
    ],
  },
  {
    enabled: isTwoFactorMethodEnabled('passkey'),
    endpoints: [
      {
        path: '/reauth/passkey/options',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/reauth/passkey/verify',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
    ],
  },
  {
    enabled: GOOGLE_ENABLED,
    endpoints: [
      {
        path: '/oauth/google/start',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: true,
        session: 'none',
      },
      {
        path: '/oauth/google/callback',
        methods: ['GET'],
        preAuthLimit: 30,
        captcha: false,
        session: 'none',
      },
      {
        path: '/oauth/result',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
        session: 'none',
      },
    ],
  },
  {
    enabled: true,
    endpoints: [
      // GET only: `getSession` refuses POST unless `session.deferSessionRefresh`
      // is enabled in `lib/auth/index.ts`; enabling it makes POST belong here.
      {
        path: '/get-session',
        methods: ['GET'],
        preAuthLimit: 300,
        captcha: false,
        session: 'optional',
      },
      {
        path: '/sign-out',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'optional',
      },
      {
        path: '/sign-in/email',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: true,
        session: 'none',
      },
    ],
  },
  {
    enabled: OTP_ENABLED && PASSWORDLESS_ENABLED,
    endpoints: [
      // Verifies its own captcha, rate limit and OTP.
      {
        path: '/passwordless/verify',
        methods: ['POST'],
        preAuthLimit: 60,
        captcha: true,
        session: 'none',
      },
    ],
  },

  // `/two-factor/send-otp` and `/two-factor/verify-otp` are absent: the
  // plugin's OTP is not configured. ⚠️ `/two-factor/enable` stays absent; it
  // writes the flag and credential outside the intent-row transaction.
  {
    enabled: TWO_FACTOR_ENABLED,
    endpoints: [
      {
        path: '/two-factor/disable',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
    ],
  },
  {
    enabled: isTwoFactorMethodEnabled('totp'),
    endpoints: [
      {
        path: '/two-factor/get-totp-uri',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/totp/start',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/totp/confirm',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'session',
      },
      // Its real budget is the per-challenge attempt counter.
      {
        path: '/two-factor/verify-totp',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'challenge',
      },
    ],
  },
  {
    enabled: TWO_FACTOR_ENABLED,
    endpoints: [
      {
        path: '/two-factor/trust-device',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/trusted-devices',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/trusted-devices/revoke',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/methods',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/methods/disable',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/methods/default',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/backup-codes/acknowledge',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
    ],
  },
  {
    enabled: TWO_FACTOR_OTP_AVAILABLE,
    endpoints: [
      {
        path: '/two-factor/otp/send',
        methods: ['POST'],
        // Below the verify budget: every request here can cost a message.
        preAuthLimit: 20,
        captcha: false,
        session: 'session-or-challenge',
      },
      {
        path: '/two-factor/otp/verify',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'session-or-challenge',
      },
    ],
  },
  {
    enabled: isTwoFactorMethodEnabled('backup_code'),
    endpoints: [
      {
        path: '/two-factor/generate-backup-codes',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/verify-backup-code',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'challenge',
      },
    ],
  },
  {
    enabled: isTwoFactorMethodEnabled('passkey'),
    endpoints: [
      {
        path: '/two-factor/passkey/grant',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/passkey/generate-register-options',
        methods: ['GET'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/passkey/verify-registration',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
        session: 'session',
      },
      {
        path: '/passkey/list-user-passkeys',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
        session: 'session',
      },
      {
        path: '/passkey/delete-passkey',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'session',
      },
      {
        path: '/passkey/update-passkey',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'session',
      },
      {
        path: '/two-factor/passkey/options',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'challenge',
      },
      {
        path: '/two-factor/passkey/verify',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
        session: 'challenge',
      },
      // ⚠️ `/passkey/generate-authenticate-options` and
      // `/passkey/verify-authentication` stay absent: an unauthenticated sign-in.
    ],
  },
];

/**
 * Kept free of Better Auth imports: `path-policy.ts`, `app.ts` and
 * `lib/http/openapi/` all read it. Methods must match the library's own
 * endpoint definitions.
 *
 * ⚠️ A password-bearing path added here must also be in `PASSWORD_PROOF_PATHS`,
 * or it rejects every password.
 */
export const BETTER_AUTH_ENDPOINTS: readonly RoutePrefixPath[] =
  ENDPOINT_GROUPS.filter((group) => group.enabled).flatMap(
    (group) => group.endpoints
  );

/**
 * Every row under SOME configuration, so the contract builder can tell a
 * switched-off path from a typo. ⚠️ Never for enforcement.
 */
export const BETTER_AUTH_KNOWN_ENDPOINTS: readonly RoutePrefixPath[] =
  ENDPOINT_GROUPS.flatMap((group) => group.endpoints);

export const BETTER_AUTH_KNOWN_PATHS: ReadonlySet<string> = new Set(
  BETTER_AUTH_KNOWN_ENDPOINTS.map((endpoint) => endpoint.path)
);

export const BETTER_AUTH_ROUTE_PREFIX: RoutePrefix = {
  prefix: BETTER_AUTH_PREFIX,
  // Nothing here takes a file, so no caller can claim the upload allowance.
  body: 'json',
  paths: BETTER_AUTH_ENDPOINTS,
};

export const BETTER_AUTH_ALLOWED_PATH_SET: ReadonlySet<string> = new Set(
  BETTER_AUTH_ENDPOINTS.map((endpoint) => endpoint.path)
);

const SERVED_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  BETTER_AUTH_ENDPOINTS.map((endpoint) => [
    endpoint.path,
    new Set<string>(endpoint.methods),
  ])
);

// `HEAD` from the `GET` entry, as the route lookup does for bindings.
export function betterAuthServes(path: string, method: string): boolean {
  const served = SERVED_METHODS.get(path);
  if (!served) return false;
  return served.has(method === 'HEAD' ? 'GET' : method);
}
