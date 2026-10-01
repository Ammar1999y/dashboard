import type { HookContext } from './context';

import { isDeadlock } from '@/db/errors';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { APIError, isAPIError } from 'better-auth/api';

import {
  EMAIL_NOT_VERIFIED_CODE,
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
  MSG_LOGIN_REQUIRED,
  MSG_REAUTH_REQUIRED,
  MSG_SERVICE_UNAVAILABLE,
  PHONE_NOT_VERIFIED_CODE,
  REAUTH_REQUIRED_CODE,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { logSanitized } from '@/utils/log';

/** Tells the `after` hook to leave the already-localised message alone. */
export const CUSTOM_AUTH_CODE = '__' as const;

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

export const MSG_UNTRUSTED_ORIGIN =
  'تعذر إكمال الطلب من هذا الموقع. أعد تحميل الصفحة من الرابط الرسمي ثم حاول مرة أخرى.';

/** Better Auth's own error codes, localised by the `after` hook and by `app.ts`. */
export const BASE_ERROR_CODES: Record<string, string> = {
  USER_NOT_FOUND: 'المستخدم غير موجود',
  FAILED_TO_CREATE_USER:
    'حدث خطأ ما في عملية إنشاء المستخدم، حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_CREATE_SESSION:
    'حدث خطأ ما في عملية إنشاء الجلسة، حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_UPDATE_USER:
    'حدث خطأ ما في عملية تحديث المستخدم، حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_GET_SESSION:
    'حدث خطأ ما في عملية الحصول على بيانات الجلسة، حاول مجددا، او اعد تحميل الصفحة',
  INVALID_PASSWORD: 'كلمة المرور غير صحيحة',
  INVALID_EMAIL: 'البريد الالكتروني غير صحيح',
  INVALID_EMAIL_OR_PASSWORD: MSG_INVALID_CREDENTIALS,
  INVALID_TOKEN: 'حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_GET_USER_INFO:
    'حدث خطأ ما في عملية الحصول على بيانات المستخدم، حاول مجددا، او اعد تحميل الصفحة',
  USER_EMAIL_NOT_FOUND: 'البريد الالكتروني غير موجود',

  SOCIAL_ACCOUNT_ALREADY_LINKED: 'Social account already linked',
  PROVIDER_NOT_FOUND: 'Provider not found',
  ID_TOKEN_NOT_SUPPORTED: 'id_token not supported',
  PASSWORD_TOO_SHORT: 'Password too short',
  PASSWORD_TOO_LONG: 'Password too long',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'Credential account not found',
  USER_ALREADY_HAS_PASSWORD:
    'User already has a password. Provide that to delete the account.',
  FAILED_TO_UNLINK_LAST_ACCOUNT: "You can't unlink your last account",

  EMAIL_NOT_VERIFIED: 'البريد الالكتروني غير موثوق',
  EMAIL_CAN_NOT_BE_UPDATED: 'لايمكن تحديث البريد الالكتروني',
  SESSION_EXPIRED: 'قم باعادة تسجيل الدخول',
  SESSION_NOT_FRESH: 'مضى وقت طويل على تسجيل دخولك، قم بتسجيل الدخول مرة أخرى',
  ACCOUNT_NOT_FOUND: 'الحساب غير موجود',

  // ⚠️ `trustedOrigins` is unset, so a cross-origin front-end gets 403 on every
  // sign-in despite `CORS_POLICY`; set it if the front-end moves origin.
  INVALID_ORIGIN: MSG_UNTRUSTED_ORIGIN,
  MISSING_OR_NULL_ORIGIN: MSG_UNTRUSTED_ORIGIN,
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: MSG_UNTRUSTED_ORIGIN,

  // No `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED`: `POST /get-session` is
  // answered 405 by `app.ts` from `BETTER_AUTH_ENDPOINTS` before Better Auth runs.

  USER_ALREADY_EXISTS:
    'المستخدم موجود بالفعل، استخدم بريد الكتروني اخر لإنشاء الحساب',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'المستخدم موجود بالفعل، استخدم بريد الكتروني اخر لإنشاء الحساب',

  ux_users_phone_number: 'رقم الهاتف موجود من قبل، استخدم رقم هاتف اخر',

  // `tests/integration/auth-error-localisation.test.ts` fails if another
  // unmapped code becomes reachable.
  VALIDATION_ERROR: MSG_INVALID_INPUT,
  BAD_REQUEST: MSG_INVALID_INPUT,

  MISSING_RESPONSE:
    'تعذر التحقق من أنك لست روبوتاً. أعد تحميل الصفحة وحاول مرة أخرى',
  VERIFICATION_FAILED:
    'تعذر التحقق من أنك لست روبوتاً. أعد تحميل الصفحة وحاول مرة أخرى',
  UNKNOWN_ERROR: 'حاول مجددا، او اعد تحميل الصفحة',
};

// Own-property read: `constructor` would resolve to an inherited function.
export function localisedAuthMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(BASE_ERROR_CODES, code)
    ? BASE_ERROR_CODES[code]
    : undefined;
}

/** Better Auth's `after` hook. */
export async function localiseAuthErrors(ctx: HookContext): Promise<void> {
  // Not `instanceof`: an APIError may cross a module-instance boundary.
  const returned = ctx.context?.returned;
  const failure = isAPIError(returned) ? returned : undefined;
  const errorCode = failure?.body?.code;

  const mappedMessage = localisedAuthMessage(errorCode);

  if (errorCode && errorCode !== CUSTOM_AUTH_CODE && mappedMessage) {
    throw authError(
      failure?.status || failure?.statusCode || HTTP_STATUS.BAD_REQUEST,
      mappedMessage
    );
  }
  if (
    errorCode &&
    errorCode !== CUSTOM_AUTH_CODE &&
    errorCode !== EMAIL_NOT_VERIFIED_CODE &&
    errorCode !== PHONE_NOT_VERIFIED_CODE
  )
    logSanitized('error', ctx.context?.returned);
}
