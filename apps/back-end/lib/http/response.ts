import type { Handler, HandlerCookie, HandlerOutput } from './contract';
import type { PaginationMeta } from '@app/shared/types/api';

import { isInvalidTextEncoding } from '@/db/errors';

import {
  HTTP_STATUS,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_PAGE_NOT_FOUND,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { sanitizeForLog } from '@/utils/log';

import { responsePayload, serializeSetCookie } from './contract';

interface ApiSuccessOptions<T = unknown> {
  message: string;
  data?: T;
  meta?: PaginationMeta;
  status?: number;
  headers?: Record<string, string>;
  cookies?: HandlerCookie[];
}

interface ApiErrorOptions {
  message: string;
  code?: string;
  status?: number;
  headers?: Record<string, string>;
}

export function apiSuccess<T = unknown>({
  message,
  data = null as T,
  meta,
  status = HTTP_STATUS.OK,
  headers,
  cookies,
}: ApiSuccessOptions<T>): HandlerOutput<T> {
  return {
    status,
    body: {
      success: true,
      message,
      data,
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
}): HandlerOutput<never> {
  return {
    status,
    body: { raw: body },
    ...(headers && { headers }),
  };
}

export function apiError({
  message,
  code,
  status = HTTP_STATUS.BAD_REQUEST,
  headers,
}: ApiErrorOptions): HandlerOutput<null> {
  return {
    status,
    body: { success: false, message, data: null, ...(code && { code }) },
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
): HandlerOutput<null> {
  if (error instanceof CustomError) {
    const errorHeaders = error.responseHeaders;
    const headers =
      errorHeaders || extraHeaders
        ? { ...extraHeaders, ...errorHeaders }
        : undefined;
    return apiError({
      message: error.message,
      code: error.code,
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

  console.error(sanitizeForLog(error));
  return apiError({
    message: fallbackMessage ?? MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
    ...(extraHeaders && { headers: extraHeaders }),
  });
}

/**
 * A handler whose throws become the error envelope. `mapError` claims the
 * errors the route answers specially and returns `undefined` for the rest.
 */
export function withApiErrors(
  fallbackMessage: string,
  handler: Handler,
  mapError?: (error: unknown) => HandlerOutput<null> | undefined
): Handler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      return mapError?.(error) ?? handleApiError(error, fallbackMessage);
    }
  };
}

export function requireFeature(enabled: boolean): void {
  if (!enabled)
    throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

/**
 * Every API response is per-user, credentialed, or an error, and `no-store` is
 * the one directive every intermediary, the back/forward cache included,
 * honours. A handler serving a public cacheable body sets its own
 * `Cache-Control`; this is a default, not an override.
 */
export const DEFAULT_CACHE_CONTROL = 'no-store';

/** Keep Better Auth's raw cookie values and extension attributes intact across adapters. */
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
