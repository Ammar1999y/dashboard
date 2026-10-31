import type { JWTPayload, ProtectedHeaderParameters } from 'jose';

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from 'jose';

import { GOOGLE_ISSUER, GoogleIdentityDenied } from './identity';

const GOOGLE_CERTS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

const ID_TOKEN_ALGORITHMS = ['RS256'];

/** On `exp` and `iat`: a server clock behind Google's must not refuse every sign-in. */
const CLOCK_TOLERANCE_S = 30;

/**
 * Shared, so jose's cache and its de-duplication of concurrent fetches apply:
 * it refetches when stale or on an unknown `kid` outside its cooldown.
 */
const signingKeys = { resolver: createRemoteJWKSet(GOOGLE_CERTS_URL) };

/**
 * For tests that serve their own key set: the next verification fetches it.
 *
 * @internal
 */
export function forgetGoogleSigningKeys(): void {
  signingKeys.resolver = createRemoteJWKSet(GOOGLE_CERTS_URL);
}

/**
 * A fault in what Google answered or in reaching it, as opposed to a token
 * that fails verification. It says nothing about the person signing in, so the
 * callback answers it as a server failure and never as a refused sign-in.
 */
export class GoogleProviderFault extends Error {
  constructor(
    public readonly kind:
      | 'token_endpoint_unavailable'
      | 'token_endpoint_redirected'
      | 'token_response_malformed'
      | 'signing_keys_unavailable',
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
 * Better Auth's `verifyGoogleIdToken` answers `null` for every failure, an
 * unreachable or empty key set included, so a Google outage is
 * indistinguishable from a forged token. A token with no `kid`, or a key set
 * with a duplicate one, is refused where the original tried every candidate
 * key; Google issues neither.
 */
export async function verifyGoogleIdToken(params: {
  token: string;
  audience: string;
  nonce: string;
}): Promise<JWTPayload> {
  const denied = () => new GoogleIdentityDenied('id_token_invalid');
  let header: ProtectedHeaderParameters;
  try {
    header = decodeProtectedHeader(params.token);
  } catch {
    throw denied();
  }
  // Refused here: jose answers an unrecognised `crit` with the
  // `JOSENotSupported` it also raises for key material it cannot use, which is
  // a fault. Google sets no `crit`.
  if (
    header.crit !== undefined ||
    !header.alg ||
    !ID_TOKEN_ALGORITHMS.includes(header.alg)
  )
    throw denied();

  const keys = signingKeys.resolver;
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(params.token, keys, {
      algorithms: ID_TOKEN_ALGORITHMS,
      issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
      audience: params.audience,
      maxTokenAge: '1h',
      // Otherwise `exp` is validated only when present.
      requiredClaims: ['exp'],
      clockTolerance: CLOCK_TOLERANCE_S,
    }));
  } catch (cause) {
    // An empty set answers every token as one no key matches.
    const keySetEmpty =
      cause instanceof errors.JWKSNoMatchingKey && !keys.jwks()?.keys.length;
    throw !keySetEmpty && isTokenFailure(cause)
      ? denied()
      : new GoogleProviderFault('signing_keys_unavailable', { cause });
  }
  if (
    claims.nonce !== params.nonce ||
    (claims.azp !== undefined && claims.azp !== params.audience)
  )
    throw denied();
  return claims;
}
