import type {
  HandlerCookie,
  HandlerError,
  HandlerInput,
  HandlerOutput,
  HandlerRaw,
  PaginatedOutput,
  RouteHandler,
  RouteOutput,
  SuccessOutput,
} from './contract';
import type { ResponseRoute } from '@app/shared/response-contract';
import type { MediaRefusalData } from '@app/shared/responses/media';
import type { PaginationMeta } from '@app/shared/types/api';

import { isDatabaseContention, isInvalidTextEncoding } from '@/db/errors';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { isAPIError } from 'better-auth/api';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_NOT_FOUND,
  MSG_PAGE_NOT_FOUND,
  MSG_SERVICE_UNAVAILABLE,
} from '@app/shared/messages/common';

import {
  errorClassOf,
  logSanitized,
  logServerErrorResponse,
} from '@/utils/log';

import { responsePayload } from './contract';
import { serializeSetCookie } from './cookies';
import { DEFAULT_CACHE_CONTROL } from './response-policy';

interface ApiSuccessOptions {
  message: string;
  status?: number;
  headers?: Record<string, string>;
  cookies?: HandlerCookie[];
}

interface ApiErrorOptions {
  message: string;
  code?: string;
  data?: MediaRefusalData;
  status?: number;
  headers?: Record<string, string>;
}

export function apiSuccess<const T>(
  options: ApiSuccessOptions & { data: T; meta: PaginationMeta }
): PaginatedOutput<T>;
export function apiSuccess<const T>(
  options: ApiSuccessOptions & { data: T; meta?: undefined }
): SuccessOutput<T>;
export function apiSuccess(
  options: ApiSuccessOptions & { data?: undefined; meta?: undefined }
): SuccessOutput<null>;
export function apiSuccess({
  message,
  data,
  meta,
  status = HTTP_STATUS.OK,
  headers,
  cookies,
}: ApiSuccessOptions & {
  data?: unknown;
  meta?: PaginationMeta;
}): SuccessOutput<unknown> {
  return {
    status,
    body: {
      success: true,
      message,
      data: data ?? null,
      ...(meta && { meta }),
    },
    ...(headers && { headers }),
    ...(cookies && { cookies }),
  };
}

/**
 * Response whose body is NOT the standard envelope, for a shape fixed outside
 * this codebase: the Coolify health check reads top-level fields, and an
 * OpenAPI document's shape is the spec's. Everything else uses
 * `apiSuccess`/`apiError`.
 */
export function apiRaw({
  body,
  status = HTTP_STATUS.OK,
  headers,
}: {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}): HandlerRaw {
  return {
    status,
    body: { raw: body },
    ...(headers && { headers }),
  };
}

export function apiError({
  message,
  code,
  data,
  status = HTTP_STATUS.BAD_REQUEST,
  headers,
}: ApiErrorOptions): HandlerError {
  return {
    status,
    body: {
      success: false,
      message,
      data: data ?? null,
      ...(code && { code }),
    },
    ...(headers && { headers }),
  };
}

/**
 * Maps a caught error to the error envelope. `extraHeaders` carries headers
 * (Retry-After, ...) from an original error that a catch block rewrote into a
 * new `CustomError`.
 */
export function handleApiError(
  error: unknown,
  fallbackMessage?: string,
  extraHeaders?: Record<string, string>
): HandlerError {
  if (error instanceof CustomError) {
    if (error.status !== undefined && error.status >= 500)
      logServerErrorResponse(error);
    const errorHeaders = error.responseHeaders;
    const headers =
      errorHeaders || extraHeaders
        ? { ...extraHeaders, ...errorHeaders }
        : undefined;
    return apiError({
      message: error.message,
      code: error.code,
      data: error.data,
      status: error.status,
      ...(headers && { headers }),
    });
  }

  if (isInvalidTextEncoding(error))
    return apiError({
      message: MSG_INVALID_INPUT,
      status: HTTP_STATUS.UNPROCESSABLE,
      ...(extraHeaders && { headers: extraHeaders }),
    });

  // A deadlock is the backstop for a writer that misses the users → roles lock
  // order; no connection in time is an exhausted pool or a database outage.
  if (isDatabaseContention(error)) {
    logSanitized('error', error);
    return apiError({
      message: MSG_SERVICE_UNAVAILABLE,
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      headers: {
        ...extraHeaders,
        'Retry-After': String(DATABASE_RETRY_AFTER_S),
      },
    });
  }

  // A 5xx `APIError` is logged where it is raised: Better Auth's through
  // `auth`'s logger, ours beside each `authError`. Its message is the answer
  // already composed for the client, so a 4xx one is logged by status and code.
  if (isAPIError(error)) {
    if (error.statusCode < HTTP_STATUS.INTERNAL_ERROR)
      logSanitized('error', {
        msg: 'unmapped auth error response',
        status: error.statusCode,
        errorClass: errorClassOf(error),
        authCode: error.body?.code,
      });
  } else logSanitized('error', error);
  return apiError({
    message: fallbackMessage ?? MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
    ...(extraHeaders && { headers: extraHeaders }),
  });
}

/**
 * A handler whose throws become the error envelope. `key` names its
 * `RESPONSE_DATA` route, which types every success the handler returns.
 * `mapError` claims the errors the route answers specially and returns
 * `undefined` for the rest.
 */
export function withApiErrors<K extends ResponseRoute>(
  key: K,
  fallbackMessage: string,
  handler: (ctx: HandlerInput) => Promise<RouteOutput<K>>,
  mapError?: (error: unknown) => HandlerError | undefined
): RouteHandler<K> {
  const guarded = async (ctx: HandlerInput): Promise<RouteOutput<K>> => {
    try {
      return await handler(ctx);
    } catch (error) {
      return mapError?.(error) ?? handleApiError(error, fallbackMessage);
    }
  };
  return Object.assign(guarded, { routeKey: key });
}

/** A 500 carrying the fault as `cause`, which `handleApiError` logs with it. */
export function serverFault(message: string, cause: unknown): CustomError {
  const failure = new CustomError(message, HTTP_STATUS.INTERNAL_ERROR);
  failure.cause = cause;
  return failure;
}

export function notFoundError(): CustomError {
  return new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

export function requireFeature(enabled: boolean): void {
  if (!enabled)
    throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

export function toWebResponse(output: HandlerOutput): Response {
  const headers = new Headers();
  const extraHeaders = Object.entries(output.headers ?? {});
  const cookies = output.cookies ?? [];

  for (const [key, value] of extraHeaders) headers.set(key, value);
  for (const cookie of cookies)
    headers.append('set-cookie', serializeSetCookie(cookie));

  // After the handler's own headers, so an explicit opt-out wins.
  if (!headers.has('cache-control'))
    headers.set('cache-control', DEFAULT_CACHE_CONTROL);

  return Response.json(responsePayload(output.body), {
    status: output.status,
    headers,
  });
}
