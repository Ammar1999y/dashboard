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

export const FILE_NOT_FOUND_CODE = 'FILE_NOT_FOUND' as const;
export const FOLDER_NOT_FOUND_CODE = 'FOLDER_NOT_FOUND' as const;
export const FILE_BUSY_CODE = 'FILE_BUSY' as const;
export const FILE_IN_USE_CODE = 'FILE_IN_USE' as const;
/** A folder holding an upload still in flight; abandoned uploads never block. */
export const FOLDER_BUSY_CODE = 'FOLDER_BUSY' as const;
export const FOLDER_NAME_EXISTS_CODE = 'FOLDER_NAME_EXISTS' as const;
export const FOLDER_NOT_EMPTY_CODE = 'FOLDER_NOT_EMPTY' as const;
export const FOLDER_TOO_DEEP_CODE = 'FOLDER_TOO_DEEP' as const;
export const FOLDER_CYCLE_CODE = 'FOLDER_CYCLE' as const;
export const FOLDER_TOO_MANY_CHILDREN_CODE =
  'FOLDER_TOO_MANY_CHILDREN' as const;
export const SELECTION_TOO_LARGE_CODE = 'SELECTION_TOO_LARGE' as const;
export const VISIBILITY_DISABLED_CODE = 'VISIBILITY_DISABLED' as const;
export const UNPUBLISH_IN_USE_CODE = 'UNPUBLISH_IN_USE' as const;
export const LINK_NOT_ALLOWED_CODE = 'LINK_NOT_ALLOWED' as const;
export const LINK_VISIBILITY_MISMATCH_CODE =
  'LINK_VISIBILITY_MISMATCH' as const;
export const FILE_KIND_NOT_ALLOWED_CODE = 'FILE_KIND_NOT_ALLOWED' as const;
export const FILE_TYPE_NOT_ALLOWED_CODE = 'FILE_TYPE_NOT_ALLOWED' as const;
export const FILE_TOO_LARGE_CODE = 'FILE_TOO_LARGE' as const;
/** Bytes that are not what they claim, or that carry something refused. */
export const FILE_CONTENT_REFUSED_CODE = 'FILE_CONTENT_REFUSED' as const;
/** Pixels, an edge or an embedded colour profile over its bound. */
export const IMAGE_TOO_LARGE_CODE = 'IMAGE_TOO_LARGE' as const;
export const IMAGE_NOT_COMPRESSIBLE_CODE = 'IMAGE_NOT_COMPRESSIBLE' as const;

/** Every code a media or upload refusal carries; the message is for people. */
export const MEDIA_ERROR_CODES = [
  FILE_NOT_FOUND_CODE,
  FOLDER_NOT_FOUND_CODE,
  FILE_BUSY_CODE,
  FILE_IN_USE_CODE,
  FOLDER_BUSY_CODE,
  FOLDER_NAME_EXISTS_CODE,
  FOLDER_NOT_EMPTY_CODE,
  FOLDER_TOO_DEEP_CODE,
  FOLDER_CYCLE_CODE,
  FOLDER_TOO_MANY_CHILDREN_CODE,
  SELECTION_TOO_LARGE_CODE,
  VISIBILITY_DISABLED_CODE,
  UNPUBLISH_IN_USE_CODE,
  LINK_NOT_ALLOWED_CODE,
  LINK_VISIBILITY_MISMATCH_CODE,
  FILE_KIND_NOT_ALLOWED_CODE,
  FILE_TYPE_NOT_ALLOWED_CODE,
  FILE_TOO_LARGE_CODE,
  FILE_CONTENT_REFUSED_CODE,
  IMAGE_TOO_LARGE_CODE,
  IMAGE_NOT_COMPRESSIBLE_CODE,
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

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
