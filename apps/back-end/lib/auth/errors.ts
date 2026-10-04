import type { HookContext } from './context';

import { isDeadlock } from '@/db/errors';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { APIError, isAPIError } from 'better-auth/api';

import { CustomError } from '@app/shared/error-class';
import {
  CUSTOM_AUTH_CODE,
  REAUTH_REQUIRED_CODE,
  ROUTING_CODES,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  betterAuthMsg,
  MSG_INVALID_CREDENTIALS,
  MSG_LOGIN_REQUIRED,
  MSG_REAUTH_REQUIRED,
} from '@app/shared/messages/auth';
import { MSG_SERVICE_UNAVAILABLE } from '@app/shared/messages/common';

import { logSanitized } from '@/utils/log';

type AuthErrorStatus = NonNullable<ConstructorParameters<typeof APIError>[0]>;

// Key order is part of the response: `{ code, message }` sites use `authErrorCodeFirst`.
export function authError(
  status: AuthErrorStatus,
  message: string,
  headers?: HeadersInit
): APIError {
  return new APIError(status, { message, code: CUSTOM_AUTH_CODE }, headers);
}

export function authErrorCodeFirst(
  status: AuthErrorStatus,
  message: string
): APIError {
  return new APIError(status, { code: CUSTOM_AUTH_CODE, message });
}

/**
 * `handleApiError`'s deadlock answer, in Better Auth's shape. Logged here: a 5xx
 * `APIError` is not logged again downstream, and the deadlock is the lock-order
 * bug this exists to expose.
 */
export function databaseContended(cause: unknown): APIError {
  logSanitized('error', cause);
  return authError(HTTP_STATUS.SERVICE_UNAVAILABLE, MSG_SERVICE_UNAVAILABLE, {
    'Retry-After': String(DATABASE_RETRY_AFTER_S),
  });
}

export function authenticationDenied(): APIError {
  return authErrorCodeFirst(HTTP_STATUS.UNAUTHORIZED, MSG_INVALID_CREDENTIALS);
}

export function sessionRequired(): APIError {
  return authError(HTTP_STATUS.UNAUTHORIZED, MSG_LOGIN_REQUIRED);
}

export function reauthenticationRequired(): APIError {
  return new APIError(HTTP_STATUS.UNAUTHORIZED, {
    code: REAUTH_REQUIRED_CODE,
    message: MSG_REAUTH_REQUIRED,
  });
}

/**
 * Any non-`APIError` throw escapes `auth.handler` to `app.ts`. 429 and 503 keep
 * their headers; `genericMessage` answers every other status, collapsing
 * account-revealing failures.
 */
export function toAuthApiError(
  error: CustomError,
  genericMessage: string
): APIError {
  switch (error.status) {
    case HTTP_STATUS.UNAUTHORIZED: {
      return error.code === REAUTH_REQUIRED_CODE
        ? reauthenticationRequired()
        : authenticationDenied();
    }
    case HTTP_STATUS.TOO_MANY_REQUESTS: {
      return authError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        error.message,
        error.responseHeaders
      );
    }
    case HTTP_STATUS.SERVICE_UNAVAILABLE: {
      return authError(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        error.message,
        error.responseHeaders
      );
    }
    case HTTP_STATUS.FORBIDDEN: {
      return authError(HTTP_STATUS.FORBIDDEN, error.message);
    }
    case HTTP_STATUS.UNPROCESSABLE: {
      return authError(HTTP_STATUS.UNPROCESSABLE, error.message);
    }
    default: {
      return authError(HTTP_STATUS.BAD_REQUEST, genericMessage);
    }
  }
}

/** `toAuthApiError` for a caught value: an `APIError` or a non-project throw passes through. */
export function asAuthError(caught: unknown, genericMessage: string): unknown {
  if (caught instanceof APIError) return caught;
  if (caught instanceof CustomError)
    return toAuthApiError(caught, genericMessage);
  if (isDeadlock(caught)) return databaseContended(caught);
  return caught;
}

// Own-property read: `constructor` would resolve to an inherited function.
export function localisedAuthMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(betterAuthMsg, code)
    ? betterAuthMsg[code]
    : undefined;
}

/**
 * The body both localisers answer with. A routing code is kept, not replaced by
 * `CUSTOM_AUTH_CODE`: Better Auth declares `EMAIL_NOT_VERIFIED` too, so the
 * two raisers share one code and one message.
 */
export function localisedAuthBody(
  code: unknown
): { message: string; code: string } | undefined {
  const message = localisedAuthMessage(code);
  if (message === undefined) return undefined;
  return {
    message,
    code:
      typeof code === 'string' && ROUTING_CODES.has(code)
        ? code
        : CUSTOM_AUTH_CODE,
  };
}

/** Better Auth's `after` hook. */
export async function localiseAuthErrors(ctx: HookContext): Promise<void> {
  localiseReturnedAuthError(ctx.context?.returned);
}

/** The `after` hook's work on what the endpoint returned: throws the localised error. */
export function localiseReturnedAuthError(returned: unknown): void {
  // Not `instanceof`: an APIError may cross a module-instance boundary.
  const failure = isAPIError(returned) ? returned : undefined;
  const errorCode = failure?.body?.code;

  if (!errorCode || errorCode === CUSTOM_AUTH_CODE) return;

  const localised = localisedAuthBody(errorCode);
  if (localised) {
    throw new APIError(
      failure?.status || failure?.statusCode || HTTP_STATUS.BAD_REQUEST,
      localised
    );
  }
  if (!ROUTING_CODES.has(errorCode)) logSanitized('error', returned);
}
