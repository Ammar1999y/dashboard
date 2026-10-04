/**
 * Distinct error code returned ONLY when login is blocked because the email is
 * unverified (REQUIRE_EMAIL_VERIFICATION). Every other login failure keeps the
 * generic invalid-credentials response, so this leaks nothing pre-password.
 * The frontend keys on it to route the user into the OTP verification flow.
 */
export const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED' as const;

/** Distinct code for the phone-verification login gate (REQUIRE_PHONE_VERIFICATION). */
export const PHONE_NOT_VERIFIED_CODE = 'PHONE_NOT_VERIFIED' as const;
/**
 * The first factor succeeded but the account has no second factor it can
 * complete, so the login is refused rather than downgraded. The frontend routes
 * on this to an account-recovery page rather than a retry.
 */
export const TWO_FACTOR_UNAVAILABLE_CODE = 'TWO_FACTOR_UNAVAILABLE' as const;
/**
 * The administrative action needs a fresh password proof, not just a session.
 * The frontend routes on this to a re-authentication prompt and then retries
 * with the header, rather than treating it as a sign-in failure.
 */
export const REAUTH_REQUIRED_CODE = 'REAUTH_REQUIRED' as const;

/** Tells the `after` hook to leave the already-localised message alone. */
export const CUSTOM_AUTH_CODE = '__' as const;

/**
 * The codes this project raises and its front-end routes on. They are expected
 * flows, answered already in Arabic, so the localisers keep the code and the
 * `after` hook does not log them.
 */
export const ROUTING_CODES: ReadonlySet<unknown> = new Set([
  EMAIL_NOT_VERIFIED_CODE,
  PHONE_NOT_VERIFIED_CODE,
  REAUTH_REQUIRED_CODE,
  TWO_FACTOR_UNAVAILABLE_CODE,
]);
