/**
 * The Better Auth corrections that are data alone, keyed by the path under the
 * prefix; `better-auth.ts` applies them to the library's generated document.
 */
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
  '500': 'Better Auth, or one of its dependencies, failed.',
  '400': 'Required request input was absent or invalid for this endpoint.',
  '401':
    'Credentials refused, or the session this request would create is not allowed to exist (inactive user, inactive role).',
  '403':
    'Captcha verification failed, the request origin is not trusted, or the account has an unverified contact channel.',
  '422':
    'The submitted fields failed this project’s own schema for the endpoint.',
  '409':
    'The request would leave the account in a state this application refuses — removing the only enrolled second factor.',
} as const;

/**
 * Statuses reachable on some allowlisted paths only, keyed like
 * `BETTER_AUTH_BODIES`. `/get-session` is a GET, so the origin check that
 * produces 403 does not apply and an absent session is a 200 carrying `null`;
 * the paths that create a session run the `session.create` hook in
 * `lib/auth/session/hooks.ts`, which is what can refuse 401 or 403.
 */
export const BETTER_AUTH_PATH_STATUSES: Record<
  string,
  readonly (keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS)[]
> = {
  '/capabilities': [],
  '/reauth/methods': ['401'],
  '/reauth/passkey/options': ['400', '401', '403'],
  '/reauth/passkey/verify': ['400', '401', '403'],
  '/oauth/google/start': ['400', '401', '403'],
  '/oauth/google/callback': ['400', '401'],
  '/oauth/result': ['401'],
  '/sign-in/email': ['400', '401', '403', '422'],
  '/sign-out': ['400', '403'],
  '/passwordless/verify': ['400', '401', '403', '422'],
  // 403 on the POST paths is Better Auth's origin check (`validateOrigin`),
  // which refuses a cookie-bearing call with no `origin` before the handler
  // runs. GET paths skip that check.
  '/two-factor/disable': ['401', '403', '422'],
  '/two-factor/get-totp-uri': ['401', '403', '422'],
  // 409 is the refusal to replace an authenticator that already works.
  '/two-factor/totp/start': ['401', '403', '404', '409', '422'],
  '/two-factor/totp/confirm': ['400', '401', '403', '404', '409', '422'],
  '/two-factor/verify-totp': ['400', '403', '422'],
  '/two-factor/generate-backup-codes': ['401', '403', '404', '422'],
  '/two-factor/verify-backup-code': ['400', '403', '422'],
  '/two-factor/otp/send': ['400', '401', '403', '422'],
  '/two-factor/otp/verify': ['400', '401', '403', '422'],
  '/two-factor/passkey/options': ['400', '401', '403', '422'],
  '/two-factor/passkey/verify': ['400', '401', '403', '422'],
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
  '/passkey/verify-registration': ['400', '401', '403', '409', '422'],
  '/passkey/list-user-passkeys': ['401'],
  // 404 is a passkey that is not the caller's; 409 the last-method refusal.
  '/passkey/delete-passkey': ['400', '401', '403', '404', '409', '422'],
  '/passkey/update-passkey': ['400', '401', '403', '422'],
};

/**
 * Paths that throttle inside the endpoint as well as at the wildcard's
 * admission limiter, and so answer 429/503 in two body shapes: the wildcard's
 * goes to `handleApiError` (envelope), an inner `CustomError` to
 * `toAuthApiError`.
 */
export const BETTER_AUTH_LOCAL_THROTTLE_PATHS = new Set([
  '/reauth/passkey/options',
  '/reauth/passkey/verify',
  '/passwordless/verify',
  // `enforceOtpSurfaceSendQuota` / `enforceOtpVerifyQuota`.
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

/** The paths whose 200 is a union of "signed in" and "challenged". */
export const TWO_FACTOR_CHALLENGE_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/passwordless/verify',
]);

/**
 * Paths whose generated 200 was read and found to match what is served. An
 * explicit attestation, so "unchecked" and "checked and correct" differ.
 */
export const BETTER_AUTH_TRUSTED_RESPONSES: ReadonlySet<string> = new Set([
  '/capabilities',
  '/reauth/methods',
  '/reauth/passkey/options',
  '/reauth/passkey/verify',
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/passwordless/verify',
  '/oauth/google/start',
  '/oauth/google/callback',
  '/oauth/result',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/totp/start',
  '/two-factor/totp/confirm',
  '/two-factor/trust-device',
  '/two-factor/trusted-devices',
  '/two-factor/trusted-devices/revoke',
  '/two-factor/methods',
  '/two-factor/methods/disable',
  '/two-factor/methods/default',
  '/two-factor/backup-codes/acknowledge',
  '/two-factor/generate-backup-codes',
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
  '/two-factor/passkey/grant',
  '/two-factor/passkey/options',
  '/two-factor/passkey/verify',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);
