import { betterFetch } from '@better-fetch/fetch';
import { authorizationCodeRequest } from 'better-auth/oauth2';

import { GoogleProviderFault } from './id-token';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The bound jose puts on the key-set fetch that follows. */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 5000;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * The code exchange the Google provider's `validateAuthorizationCode` makes
 * (the library builds the request: PKCE verifier, client authentication,
 * redirect URI; a redirect is refused), with an abort signal on the transport:
 * the library passes none, so a stalled token endpoint would hold the callback
 * for as long as the runtime allows.
 *
 * Answers the ID token. An error answer is thrown as betterFetch's plain
 * `{ ...body, status, statusText }`, the shape the library throws.
 */
export async function exchangeGoogleCode(params: {
  code: string;
  codeVerifier: string;
  redirectURI: string;
  credentials: { clientId: string; clientSecret: string };
}): Promise<string> {
  const request = await authorizationCodeRequest({
    code: params.code,
    codeVerifier: params.codeVerifier,
    redirectURI: params.redirectURI,
    options: params.credentials,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  });
  let redirected = false;
  const answer = await betterFetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    body: request.body,
    headers: request.headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    onError: ({ response }) => {
      if (
        response.type === 'opaqueredirect' ||
        REDIRECT_STATUSES.has(response.status)
      )
        redirected = true;
    },
  }).catch((cause: unknown) => {
    throw new GoogleProviderFault('token_endpoint_unavailable', { cause });
  });
  if (redirected) throw new GoogleProviderFault('token_endpoint_redirected');
  if (answer.error) throw answer.error;

  const data: unknown = answer.data;
  const idToken: unknown =
    typeof data === 'object' && data !== null
      ? Reflect.get(data, 'id_token')
      : undefined;
  if (typeof idToken !== 'string' || !idToken)
    throw new GoogleProviderFault('token_response_malformed');
  return idToken;
}
