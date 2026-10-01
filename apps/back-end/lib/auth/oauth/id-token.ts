import type { JWTPayload } from 'jose';

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from 'jose';

import { GOOGLE_ISSUER, GoogleIdentityDenied } from './identity';

const GOOGLE_CERTS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

const ID_TOKEN_ALGORITHMS = ['RS256'];

/**
 * A fault in what Google answered or in reaching it, as opposed to a token
 * that fails verification. It says nothing about the person signing in, so the
 * callback answers it as a server failure and never as a refused sign-in.
 */
export class GoogleProviderFault extends Error {
  constructor(
    public readonly kind:
      'token_response_malformed' | 'signing_keys_unavailable',
    options?: ErrorOptions
  ) {
    super(kind, options);
    this.name = 'GoogleProviderFault';
  }
}

/** Every failure `jwtVerify` raises about the token itself, as opposed to the key material it was handed. */
const TOKEN_FAILURES = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

function isTokenFailure(error: unknown) {
  return TOKEN_FAILURES.some((failure) => error instanceof failure);
}

/**
 * Better Auth's `verifyGoogleIdToken` runs these checks but answers `null` for
 * every failure, including an unreachable or empty key set, so a Google outage
 * is indistinguishable from a forged token. The checks are the same: RS256 only,
 * Google's two issuer spellings, this client as audience, a token no older than
 * an hour, and the flow's nonce. The key set is fetched on every call, as there.
 * A token with no `kid`, or a key set with a duplicate one, is refused where the
 * original tried every candidate key; Google issues neither.
 *
 * Throws `GoogleIdentityDenied` for a token that fails verification and
 * `GoogleProviderFault` when the signing keys cannot be had.
 */
export async function verifyGoogleIdToken(params: {
  token: string;
  audience: string;
  nonce: string;
}): Promise<JWTPayload> {
  const denied = () => new GoogleIdentityDenied('id_token_invalid');
  let algorithm: string | undefined;
  try {
    algorithm = decodeProtectedHeader(params.token).alg;
  } catch {
    throw denied();
  }
  if (!algorithm || !ID_TOKEN_ALGORITHMS.includes(algorithm)) throw denied();

  const keys = createRemoteJWKSet(GOOGLE_CERTS_URL);
  try {
    await keys.reload();
  } catch (cause) {
    throw new GoogleProviderFault('signing_keys_unavailable', { cause });
  }
  if (!keys.jwks()?.keys.length)
    throw new GoogleProviderFault('signing_keys_unavailable');

  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(params.token, keys, {
      algorithms: ID_TOKEN_ALGORITHMS,
      issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
      audience: params.audience,
      maxTokenAge: '1h',
    }));
  } catch (cause) {
    throw isTokenFailure(cause)
      ? denied()
      : new GoogleProviderFault('signing_keys_unavailable', { cause });
  }
  if (
    claims.nonce !== params.nonce ||
    // `jwtVerify` validates exp when present, but does not require the claim.
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= Math.floor(Date.now() / 1000) ||
    (claims.azp !== undefined && claims.azp !== params.audience)
  )
    throw denied();
  return claims;
}
