/**
 * The Better Auth corrections that are data alone, keyed by the path under the
 * prefix; `merge-better-auth.ts` applies them to the library's generated
 * document.
 */
import type { PluginPath } from '@app/shared/api/all';
import type { Assert, UnknownFieldsOf } from '@app/shared/api/fields-are-typed';
import type * as z from 'zod';

import { loginSchema } from '@app/shared/validation/auth';
import { twoFactorPasswordSchema } from '@app/shared/validation/two-factor';

import { SERVER_FAILURE } from '../refusals';

export const BETTER_AUTH_SUMMARIES: Record<string, string> = {
  'GET /capabilities': 'Read enabled OAuth sign-in providers',
  'GET /reauth/methods': 'Read usable reauthentication methods',
  'POST /reauth/passkey/options': 'Start passkey reauthentication',
  'POST /reauth/passkey/verify': 'Complete passkey reauthentication',
  'POST /oauth/google/start': 'Start Google sign-in',
  'GET /oauth/google/callback': 'Complete the verified Google exchange',
  'GET /oauth/result': 'Consume the Google redirect result',
  'GET /get-session': 'Get the current Better Auth session',
  'POST /sign-out': 'Sign out the current session',
  'POST /sign-in/email': 'Sign in with email and password',
  'POST /passwordless/verify': 'Verify a passwordless sign-in code',
  'POST /two-factor/disable': 'Disable two-factor authentication',
  'POST /two-factor/get-totp-uri': 'Get the TOTP enrolment URI',
  'POST /two-factor/totp/start': 'Begin authenticator-app enrolment',
  'POST /two-factor/totp/confirm': 'Confirm authenticator-app enrolment',
  'POST /two-factor/verify-totp': 'Verify a TOTP code',
  'POST /two-factor/generate-backup-codes': 'Generate new backup codes',
  'POST /two-factor/verify-backup-code': 'Verify a backup code',
  'POST /two-factor/otp/send': 'Send a second-factor code',
  'POST /two-factor/otp/verify': 'Verify a second-factor code',
  'POST /two-factor/passkey/options': 'Start a passkey second-factor ceremony',
  'POST /two-factor/passkey/verify': 'Verify a passkey second factor',
  'POST /two-factor/trust-device': 'Trust this device for two-factor',
  'GET /two-factor/trusted-devices': 'List trusted devices',
  'POST /two-factor/trusted-devices/revoke': 'Revoke a trusted device',
  'GET /two-factor/methods': 'List enrolled second factors',
  'POST /two-factor/methods/disable': 'Remove one second factor',
  'POST /two-factor/methods/default': 'Choose the default second factor',
  'POST /two-factor/passkey/grant': 'Re-authenticate before a passkey ceremony',
  'POST /two-factor/backup-codes/acknowledge':
    'Confirm the backup codes were saved',
  'GET /passkey/generate-register-options': 'Start passkey registration',
  'POST /passkey/verify-registration': 'Complete passkey registration',
  'GET /passkey/list-user-passkeys': 'List the user’s passkeys',
  'POST /passkey/delete-passkey': 'Delete a passkey',
  'POST /passkey/update-passkey': 'Rename a passkey',
};

export const BETTER_AUTH_STATUS_DESCRIPTIONS = {
  '404':
    'The Better Auth endpoint is unavailable in the current feature configuration.',
  '500': SERVER_FAILURE,
  '400':
    'The body is not JSON of the shape the endpoint reads, or required request input was absent or invalid.',
  '401':
    'Credentials refused — a password, a second-factor code, or the session or two-factor challenge the endpoint needs — or the session this request would create is not allowed to exist (inactive user, inactive role).',
  '403':
    'Captcha verification failed, the request origin is not trusted, or the account has an unverified contact channel.',
  '422':
    'The submitted fields failed this project’s own schema for the endpoint.',
  '409':
    'The request would leave the account in a state this application refuses — removing the only enrolled second factor.',
} as const;

/**
 * Statuses reachable on some allowlisted paths only, keyed by the path under
 * the prefix. `/get-session` is a GET, so the origin check that
 * produces 403 does not apply and an absent session is a 200 carrying `null`;
 * the paths that create a session run the `session.create` hook in
 * `lib/auth/session/hooks.ts`, which is what can refuse 401 or 403. Every POST
 * path also answers 400, which the merge publishes: Better Call refuses a body
 * it cannot parse before any middleware runs.
 */
export const BETTER_AUTH_PATH_STATUSES: Record<
  string,
  readonly (keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS)[]
> = {
  '/capabilities': [],
  '/reauth/methods': ['401'],
  '/reauth/passkey/options': ['401', '403'],
  '/reauth/passkey/verify': ['401', '403'],
  '/oauth/google/start': ['401', '403'],
  '/oauth/google/callback': ['400', '401'],
  '/oauth/result': ['401'],
  '/sign-in/email': ['401', '403', '422'],
  '/sign-out': ['403'],
  '/passwordless/verify': ['401', '403', '422'],
  // 403 on the POST paths is Better Auth's origin check (`validateOrigin`),
  // which refuses a cookie-bearing call with no `origin` before the handler
  // runs. GET paths skip that check.
  '/two-factor/disable': ['401', '403', '422'],
  '/two-factor/get-totp-uri': ['401', '403', '422'],
  // 409 is the refusal to replace an authenticator that already works.
  '/two-factor/totp/start': ['401', '403', '404', '409', '422'],
  '/two-factor/totp/confirm': ['401', '403', '404', '409', '422'],
  '/two-factor/verify-totp': ['401', '403', '422'],
  '/two-factor/generate-backup-codes': ['401', '403', '404', '422'],
  '/two-factor/verify-backup-code': ['401', '403', '422'],
  '/two-factor/otp/send': ['401', '403', '422'],
  '/two-factor/otp/verify': ['401', '403', '422'],
  '/two-factor/passkey/options': ['401', '403', '422'],
  '/two-factor/passkey/verify': ['401', '403', '422'],
  '/two-factor/trust-device': ['401', '403', '422'],
  '/two-factor/trusted-devices': ['401'],
  '/two-factor/trusted-devices/revoke': ['401', '403', '422'],
  '/two-factor/methods': ['401'],
  // 409 is the last-method refusal.
  '/two-factor/methods/disable': ['401', '403', '404', '409', '422'],
  '/two-factor/methods/default': ['401', '403', '404', '422'],
  '/two-factor/passkey/grant': ['401', '403', '404', '422'],
  // 409 is the refusal to acknowledge a set another tab has already replaced.
  '/two-factor/backup-codes/acknowledge': ['401', '403', '409', '422'],
  '/passkey/generate-register-options': ['401'],
  // 409 is a credential deleted between the library's write and the enrolment
  // hook, which leaves nothing to offer as a factor.
  '/passkey/verify-registration': ['401', '403', '409', '422'],
  '/passkey/list-user-passkeys': ['401'],
  // 404 is a passkey that is not the caller's; 409 the last-method refusal.
  '/passkey/delete-passkey': ['401', '403', '404', '409', '422'],
  '/passkey/update-passkey': ['401', '403', '422'],
};

/**
 * Paths that throttle inside the endpoint as well as at the wildcard's
 * admission limiter, so 429 and 503 have one more reason there.
 */
export const BETTER_AUTH_LOCAL_THROTTLE_PATHS = new Set([
  '/reauth/passkey/options',
  '/reauth/passkey/verify',
  '/passwordless/verify',
  // `enforceOtpSurfaceSendQuota` / `enforceOtpVerifyQuota`.
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

/**
 * Paths that spend a single-use input before a later transaction that can
 * answer 503, so retrying with the same input can find it spent. The remedy,
 * what that retry actually needs, replaces the 503's "retry". A path whose 503
 * rolls its spend back keeps the retry (`/two-factor/verify-backup-code`,
 * `/oauth/result`).
 */
export const BETTER_AUTH_SPENT_INPUT_REMEDIES: Readonly<
  Record<string, string>
> = {
  '/passwordless/verify':
    'a retry with the same code can find it already spent; request a new code.',
  '/two-factor/otp/verify':
    'a retry with the same code can find it already spent; request a new code, which signing in can use under the same challenge. An enrolment can retry after `Retry-After`.',
  '/two-factor/verify-totp':
    'a retry with the same code can find it already spent; wait for the authenticator’s next code.',
  '/two-factor/passkey/verify':
    'a retry with the same assertion can find its ceremony spent; start a new one at `/two-factor/passkey/options`.',
  '/passkey/delete-passkey':
    'a retry with the same grant can find it spent; request a new one at `/two-factor/passkey/grant`.',
  '/oauth/google/callback':
    'the sign-in state and Google’s code are single-use, so start a new sign-in.',
};

/**
 * Paths whose second-factor credential the library locks after repeated
 * failures (`assertTwoFactorNotLocked`), so a locked one answers 429 there.
 */
export const BETTER_AUTH_CREDENTIAL_LOCKOUT_PATHS: ReadonlySet<string> =
  new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/**
 * Paths that check the account password (`requireReauthPassword`, or the proof
 * `/two-factor/get-totp-uri` takes), so a locked account answers 429 there,
 * and a request with neither a password nor an open
 * re-authentication window answers 401 `REAUTH_REQUIRED`.
 */
export const BETTER_AUTH_PASSWORD_LOCKOUT_PATHS = new Set([
  '/two-factor/get-totp-uri',
  '/two-factor/totp/start',
  '/two-factor/generate-backup-codes',
  '/two-factor/backup-codes/acknowledge',
  '/two-factor/methods/disable',
  '/two-factor/disable',
  '/two-factor/passkey/grant',
  '/two-factor/otp/send',
]);

/** Our plugin endpoints that answer a redirect in place of a body in one mode. */
export const REDIRECTING_PLUGIN_PATHS = [
  '/oauth/google/callback',
] as const satisfies readonly PluginPath[];

/**
 * The library's own paths whose 200 this project's hook can replace with the
 * two-factor challenge (`twoFactorSignInGuard`). Our own endpoints publish the
 * challenge inside their entry’s `raw` union instead.
 */
export const TWO_FACTOR_CHALLENGE_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
]);

export const CHALLENGE_INSTEAD =
  'A two-factor account is answered with the challenge branch instead, and no session cookie.';

/** The description of each plugin endpoint's 200, whose body its entry gives. */
export const BETTER_AUTH_RESPONSE_DESCRIPTIONS = {
  '/capabilities': 'Enabled OAuth sign-in providers.',
  '/reauth/methods': 'Methods available for this authenticated account.',
  '/reauth/passkey/options':
    'User-verifying WebAuthn options bound to this session.',
  '/reauth/passkey/verify': 'Reauthentication granted.',
  '/oauth/google/start': 'Navigate to the returned Google authorization URL.',
  '/oauth/google/callback': `Google sign-in result or local two-factor challenge. A supplied callbackURL receives a redirect; retrieve the result once at /oauth/result. ${CHALLENGE_INSTEAD}`,
  '/oauth/result': `Consume the Google redirect result once. ${CHALLENGE_INSTEAD}`,
  '/passwordless/verify': `Passwordless sign-in succeeded. ${CHALLENGE_INSTEAD}`,
  '/two-factor/totp/start': 'A TOTP secret to enrol.',
  '/two-factor/totp/confirm': 'TOTP is enrolled and enabled.',
  '/two-factor/generate-backup-codes':
    'A fresh set of backup codes. `setId` NAMES this set and must be sent back to /two-factor/backup-codes/acknowledge.',
  '/two-factor/backup-codes/acknowledge':
    'The backup codes were acknowledged. `setId` must name the set the caller was shown; a different current set answers 409.',
  '/two-factor/methods': 'The caller’s enrolled methods.',
  '/two-factor/methods/disable': 'The method was removed.',
  '/two-factor/methods/default': 'The default method was set.',
  '/two-factor/disable': 'Two-factor authentication is off.',
  '/two-factor/passkey/grant': 'A single-use enrolment grant.',
  '/two-factor/otp/send': 'A second-factor code was sent.',
  '/two-factor/otp/verify':
    'The second factor was verified: a sign-in completed, or the OTP method was enrolled.',
  '/two-factor/passkey/options':
    'WebAuthn authentication options, scoped to the challenge user.',
  '/two-factor/passkey/verify':
    'The passkey assertion was verified and the sign-in completed.',
  '/two-factor/trust-device': 'This device is now trusted.',
  '/two-factor/trusted-devices': 'The caller’s trusted devices.',
  '/two-factor/trusted-devices/revoke': 'The device was revoked.',
  '/passkey/delete-passkey': 'The passkey was deleted.',
} as const satisfies Record<PluginPath, string>;

/**
 * The two verifiers answer through the plugin's shared `valid()`
 * (`verify-two-factor.mjs`), which returns `{ token, user }`, not what the
 * plugin's metadata declares; the merge publishes that body under these words.
 */
export const LIBRARY_VERIFIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '/two-factor/verify-totp':
    'The authenticator code was accepted and the sign-in is complete.',
  '/two-factor/verify-backup-code':
    'The backup code was accepted, consumed, and the sign-in is complete.',
};

export const LIBRARY_VERIFIER_PATHS: ReadonlySet<string> = new Set(
  Object.keys(LIBRARY_VERIFIER_DESCRIPTIONS)
);

/**
 * Properties of a library 200 that its generator declares wrongly, replaced by
 * what the handler sends.
 */
export const LIBRARY_SUCCESS_PROPERTIES: Readonly<
  Record<string, Readonly<Record<string, Record<string, unknown>>>>
> = {
  // `redirect: !!callbackURL` and `url: callbackURL` (`sign-in.mjs`), where the
  // generator declares `redirect` always `false` and `url` nullable.
  '/sign-in/email': {
    redirect: {
      type: 'boolean',
      description:
        '`true` exactly when the request named a `callbackURL`, which `url` then repeats and `Location` carries.',
    },
    url: {
      type: 'string',
      description: 'The request’s `callbackURL`; absent when it named none.',
    },
  },
};

/**
 * The library's own paths whose generated 200 the merge publishes, corrected
 * by `LIBRARY_SUCCESS_PROPERTIES` and by the stored model fields. An explicit
 * list, so a path with no source of its 200 fails; the integration tier holds
 * each to what is served (`tests/helpers/document-check.ts`).
 */
export const BETTER_AUTH_TRUSTED_RESPONSES: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/two-factor/get-totp-uri',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/update-passkey',
]);

/**
 * The library’s own endpoints whose request body the document publishes
 * from this project’s schema; a plugin endpoint’s comes from its entry.
 */
export const LIBRARY_REQUEST_BODIES = {
  '/sign-in/email': loginSchema.omit({ captcha: true }),
  '/two-factor/get-totp-uri': twoFactorPasswordSchema,
} as const satisfies Record<`/${string}`, z.ZodType>;

type LibraryBodyPath = keyof typeof LIBRARY_REQUEST_BODIES;

/** `UnknownFieldsOf` on the bodies above, as `api/fields-are-typed.ts` holds every entry’s. */
export type LibraryBodiesAreTyped = Assert<
  [
    {
      [P in LibraryBodyPath]: UnknownFieldsOf<
        z.input<(typeof LIBRARY_REQUEST_BODIES)[P]>
      >;
    }[LibraryBodyPath],
  ] extends [never]
    ? true
    : false
>;
