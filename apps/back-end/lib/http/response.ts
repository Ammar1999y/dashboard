import type { HandlerError, HandlerOutput, HandlerRaw } from './contract';
import type { MediaRefusalData } from '@app/shared/responses/media';
import type * as z from 'zod';

import { isDatabaseContention, isInvalidTextEncoding } from '@/db/errors';
import { DATABASE_RETRY_AFTER_S } from '@/db/limits';
import { isAPIError } from 'better-auth/api';

import { PROBLEM_MEDIA_TYPE, problemBody } from '@app/shared/api/wire';
import { CustomError } from '@app/shared/error-class';
import { INVALID_RESPONSE_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_NOT_FOUND,
  MSG_SERVICE_UNAVAILABLE,
} from '@app/shared/messages/common';

import {
  errorClassOf,
  logSanitized,
  logServerErrorResponse,
} from '@/utils/log';

import { isProblemOutput, responsePayload } from './contract';
import { serializeSetCookie } from './cookies';
import { DEFAULT_CACHE_CONTROL } from './response-policy';

interface ApiErrorOptions {
  message: string;
  code?: string;
  data?: MediaRefusalData;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Response whose body is neither a success nor a problem, for a shape fixed
 * outside this codebase: the Coolify health check reads top-level fields, and
 * an OpenAPI document's shape is the spec's. Everything else goes through
 * `successBody`/`apiError`.
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

/**
 * A raw body serialised once, for a large one that never changes: it goes out
 * as these bytes, without the per-request validation and serialisation a value
 * answer gets. Built only through `of`, which validates against the entry's
 * schema and serialises what that returns, as a value answer would be.
 */
export class SerializedJson<S extends z.ZodType = z.ZodType> {
  static of<S extends z.ZodType>(
    schema: S,
    value: z.input<S>
  ): SerializedJson<S> {
    return new SerializedJson(schema, JSON.stringify(schema.parse(value)));
  }

  private constructor(
    readonly schema: S,
    readonly text: string
  ) {}
}

/** What `Response.json` writes, so a serialised body carries the same type. */
const JSON_MEDIA_TYPE = 'application/json;charset=utf-8';

export function apiError({
  message,
  code,
  data,
  status = HTTP_STATUS.BAD_REQUEST,
  headers,
}: ApiErrorOptions): HandlerError {
  return {
    status,
    body: problemBody(status, message, code, data),
    ...(headers && { headers }),
  };
}

/**
 * Maps a caught error to a problem. `extraHeaders` carries headers
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
 * A success that failed its own schema. Coded, so a client never retries a
 * write that has committed; a refusal that breaks its contract stays a plain
 * 500, as nothing was done.
 */
export const invalidResponse = (): HandlerError =>
  apiError({
    message: MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
    code: INVALID_RESPONSE_CODE,
  });

/** A 500 carrying the fault as `cause`, which `handleApiError` logs with it. */
export function serverFault(message: string, cause: unknown): CustomError {
  const failure = new CustomError(message, HTTP_STATUS.INTERNAL_ERROR);
  failure.cause = cause;
  return failure;
}

export function notFoundError(): CustomError {
  return new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
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
  if (isProblemOutput(output)) headers.set('content-type', PROBLEM_MEDIA_TYPE);

  const payload = responsePayload(output.body);
  if (payload instanceof SerializedJson) {
    headers.set('content-type', JSON_MEDIA_TYPE);
    return new Response(payload.text, { status: output.status, headers });
  }
  return Response.json(payload, { status: output.status, headers });
}

/**
 * A GET's answer reshaped for HEAD: same status and headers, no body, and the
 * GET's length. Set explicitly: a runtime sending a body-less response declares
 * `Content-Length: 0`, which RFC 9110 §8.6 forbids for a HEAD unless the GET
 * would have sent nothing.
 */
export async function toHeadResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  if (response.body !== null) {
    const body = await response.arrayBuffer();
    headers.set('content-length', String(body.byteLength));
  }
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
