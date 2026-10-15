import type { Bookkeeping } from '@/lib/api/mutation';
import type { passkeyRequestOptionsSchema } from '@app/shared/responses/better-auth';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';

import * as z from 'zod';
import { CustomError } from '@app/shared/error-class';
import { twoFactorMsg } from '@app/shared/messages/auth';
import { passkeyGrantedSchema } from '@app/shared/responses/better-auth';
import {
  MSG_BROWSER_UNSUPPORTED,
  MSG_PASSKEY_ALREADY_REGISTERED,
  MSG_PASSKEY_CANCELLED,
  MSG_PASSKEY_FAILED,
} from '@/constants/messages';
import { invalidResponse } from '@/lib/api/fetch';

import { authRequest } from './request';

/** The `code` of each failure a ceremony can end in, for `hasErrorCode`. */
export const PASSKEY_ERROR = {
  unsupported: 'PASSKEY_UNSUPPORTED',
  /** Dismissed, timed out, or no credential on this device fits: browsers report all three alike. */
  cancelled: 'PASSKEY_CANCELLED',
  alreadyRegistered: 'PASSKEY_ALREADY_REGISTERED',
  noUserVerification: 'PASSKEY_NO_USER_VERIFICATION',
  failed: 'PASSKEY_FAILED',
} as const;

const failure = (message: string, code: string, cause?: unknown) => {
  const error = new CustomError(message, undefined, code);
  error.cause = cause;
  return error;
};

/**
 * Loaded on first use: the library is needed only on the way through a
 * ceremony, and most sessions never run one.
 */
const browserLibrary = () => import('@simplewebauthn/browser');

type BrowserLibrary = Awaited<ReturnType<typeof browserLibrary>>;

async function loadSupportedLibrary(): Promise<BrowserLibrary> {
  const library = await browserLibrary();
  if (!library.browserSupportsWebAuthn())
    throw failure(MSG_BROWSER_UNSUPPORTED, PASSKEY_ERROR.unsupported);
  return library;
}

/**
 * What the library throws, as a typed `CustomError`. A refusal it cannot name
 * is logged with its cause and reported as a failed ceremony, never as a cancel.
 */
function ceremonyError(error: unknown, library: BrowserLibrary): CustomError {
  if (error instanceof library.WebAuthnError) {
    switch (error.code) {
      case 'ERROR_CEREMONY_ABORTED': {
        return failure(MSG_PASSKEY_CANCELLED, PASSKEY_ERROR.cancelled, error);
      }
      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED': {
        return failure(
          MSG_PASSKEY_ALREADY_REGISTERED,
          PASSKEY_ERROR.alreadyRegistered,
          error
        );
      }
      case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT': {
        return failure(
          twoFactorMsg.passkeyNotUserVerifying,
          PASSKEY_ERROR.noUserVerification,
          error
        );
      }
      case 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY': {
        if (error.name === 'NotAllowedError')
          return failure(MSG_PASSKEY_CANCELLED, PASSKEY_ERROR.cancelled, error);
      }
    }
  }
  console.error(error);
  return failure(MSG_PASSKEY_FAILED, PASSKEY_ERROR.failed, error);
}

/**
 * The library's options are handed to the browser as they came; only what the
 * ceremony cannot start without is checked here, and the browser rejects a
 * malformed rest.
 */
const creationOptionsSchema = z.looseObject({
  challenge: z.string().min(1),
  rp: z.looseObject({ name: z.string() }),
  user: z.looseObject({
    id: z.string(),
    name: z.string(),
    displayName: z.string(),
  }),
  pubKeyCredParams: z.array(
    z.looseObject({ type: z.literal('public-key'), alg: z.number() })
  ),
});

/**
 * A passkey assertion for `options`, as an options endpoint answered them, in
 * the shape the verify endpoints take as `response`. Rejects with a
 * `CustomError` coded by `PASSKEY_ERROR`.
 */
export async function authenticateWithPasskey(
  optionsJSON: z.output<typeof passkeyRequestOptionsSchema>
) {
  const library = await loadSupportedLibrary();
  try {
    // The server rebuilds this itself; the stock client leaves it out too.
    const { clientExtensionResults: _, ...response } =
      await library.startAuthentication({ optionsJSON });
    return response;
  } catch (error) {
    throw ceremonyError(error, library);
  }
}

/**
 * The registration counterpart: `options` is the server's
 * `PublicKeyCredentialCreationOptionsJSON`, the result goes to
 * `/passkey/verify-registration` as `response`.
 */
export async function registerWithPasskey(options: unknown) {
  const parsed = creationOptionsSchema.safeParse(options);
  if (!parsed.success) throw invalidResponse();
  const optionsJSON: PublicKeyCredentialCreationOptionsJSON = parsed.data;
  const library = await loadSupportedLibrary();
  try {
    const { clientExtensionResults: _, ...response } =
      await library.startRegistration({ optionsJSON });
    return response;
  } catch (error) {
    throw ceremonyError(error, library);
  }
}

const storedPasskeySchema = z.object({ id: z.string() });

/**
 * A single-use grant for a passkey write, a registration or a deletion. Without
 * `password` it needs the re-authentication window, which `authRequest` asks
 * for when it is closed.
 */
export async function requestPasskeyGrant(password?: string) {
  const { data } = await authRequest('/two-factor/passkey/grant', {
    method: 'POST',
    data: password === undefined ? {} : { password },
    schema: passkeyGrantedSchema,
  });
  return data.grant;
}

interface RegisterPasskeyOptions extends Bookkeeping<
  z.output<typeof storedPasskeySchema>
> {
  password?: string;
  name?: string;
}

/**
 * Adds a passkey to the signed-in account, end to end: the single-use
 * enrolment grant, the server's options, the browser ceremony, and the
 * registration that spends the grant. Returns the stored passkey's `id`.
 *
 * Without `password` the grant needs the re-authentication window, so the
 * prompt opens first and not in the middle of the ceremony. The server refuses a
 * session older than a day with a 403 whose message asks for a new sign-in,
 * which `authRequest` rethrows as is. The bookkeeping belongs to the last
 * request, the one that commits.
 */
export async function registerPasskey({
  password,
  name,
  onSuccess,
  onUnreadAnswer,
}: RegisterPasskeyOptions = {}): Promise<string> {
  const grant = await requestPasskeyGrant(password);
  const { data: options } = await authRequest(
    '/passkey/generate-register-options',
    {
      method: 'GET',
      query: name === undefined ? undefined : { name },
      plain: true,
    }
  );
  const response = await registerWithPasskey(options);
  const { data: stored } = await authRequest('/passkey/verify-registration', {
    method: 'POST',
    data: { response, name, grant },
    schema: storedPasskeySchema,
    plain: true,
    onSuccess,
    onUnreadAnswer,
  });
  return stored.id;
}
