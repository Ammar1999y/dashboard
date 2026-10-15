import type { MediaRefusalData } from '@app/shared/responses/media';
import type { PaginationMeta } from '@app/shared/types/api';

import * as z from 'zod';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_BODY_TOO_LARGE,
  MSG_SERVICE_UNAVAILABLE,
  MSG_TOO_MANY_REQUESTS,
} from '@app/shared/messages/common';
import { paginationMetaSchema } from '@app/shared/responses/common';
import { mediaRefusalDataSchema } from '@app/shared/responses/media';
import { MSG_OFFLINE, MSG_UNEXPECTED_ERROR } from '@/constants/messages';
import { API_URL } from '@/lib/env';

const RETRY_AFTER_HEADER = 'Retry-After';

const isAbort = (error: unknown, signal: AbortSignal | null | undefined) =>
  signal?.aborted === true ||
  (error instanceof DOMException && error.name === 'AbortError');

/**
 * `fetch`, with a connection that fails as the offline `CustomError`. An abort
 * rethrows as is, for the caller that aborted it. The auth client sends its
 * requests through it too.
 */
export async function fetchOnline(
  input: string | URL | Request,
  init?: RequestInit
) {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isAbort(error, init?.signal)) throw error;
    throw new CustomError(MSG_OFFLINE, HTTP_STATUS.SERVICE_UNAVAILABLE);
  }
}

/** Fetch an API path from the back-end, with its session cookie. */
function apiFetch(path: string, init: RequestInit = {}) {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return fetchOnline(new URL(normalizedPath, `${API_URL}/`), {
    credentials: 'include',
    ...init,
  });
}

/** Every answer the API sends, a refusal included; `data` is the caller's to check. */
const envelopeSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  code: z.string().optional(),
  data: z.unknown(),
  meta: paginationMetaSchema.optional(),
});

export interface ApiResult<TData> {
  data: TData;
  message: string;
  meta?: PaginationMeta;
}

/**
 * The `code` of a successful response whose body breaks the contract. The same
 * request answers the same way again, so it is not worth retrying.
 */
export const INVALID_RESPONSE_CODE = 'invalid_response';

export const invalidResponse = () =>
  new CustomError(
    MSG_UNEXPECTED_ERROR,
    HTTP_STATUS.INTERNAL_ERROR,
    INVALID_RESPONSE_CODE
  );

/** Where a 2xx body broke what `href` should answer: paths and codes, never values. */
export function logInvalidResponse(href: string, error: z.ZodError) {
  console.error(
    `invalid response from ${href}`,
    error.issues.map(({ path, code }) => ({
      path: path.map(String).join('.'),
      code,
    }))
  );
}

/** Whether `error` is a failure tagged with `code`, by the server or this client. */
export const hasErrorCode = (error: unknown, code: string) =>
  error instanceof CustomError && error.code === code;

/**
 * Whether `error` is a refusal with `status`: for the routes that answer a
 * status and a message and no code.
 */
export const hasErrorStatus = (error: unknown, status: number) =>
  error instanceof CustomError && error.status === status;

const STATUS_MESSAGES = new Map<number, string>([
  [HTTP_STATUS.CONTENT_TOO_LARGE, MSG_BODY_TOO_LARGE],
  [HTTP_STATUS.TOO_MANY_REQUESTS, MSG_TOO_MANY_REQUESTS],
  [502, MSG_SERVICE_UNAVAILABLE],
  [HTTP_STATUS.SERVICE_UNAVAILABLE, MSG_SERVICE_UNAVAILABLE],
  [504, MSG_SERVICE_UNAVAILABLE],
]);

/** The text for a failure that came without a message, such as a proxy's error page. */
export const failureMessage = (status: number) =>
  STATUS_MESSAGES.get(status) ?? MSG_UNEXPECTED_ERROR;

/** The ids a refusal names, when its `data` names any. */
function refusalData(data: unknown): MediaRefusalData | undefined {
  const parsed = mediaRefusalDataSchema.safeParse(data);
  if (!parsed.success) return undefined;
  const { fileIds, folderIds } = parsed.data;
  return fileIds || folderIds ? parsed.data : undefined;
}

function failure(
  message: string,
  response: Response,
  code?: string,
  data?: unknown
) {
  const error = new CustomError(
    message,
    response.status,
    code,
    refusalData(data)
  );
  const retryAfter = response.headers.get(RETRY_AFTER_HEADER);
  if (retryAfter !== null)
    error.responseHeaders = { [RETRY_AFTER_HEADER]: retryAfter };
  return error;
}

const DELAY_SECONDS = /^\d+$/;
// Only the date form servers must send: `Date.parse` reads "-5" as a year.
const HTTP_DATE =
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** How long the failure's `Retry-After` asks to wait, when it has a readable one. */
export function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof CustomError)) return undefined;
  const value = error.responseHeaders?.[RETRY_AFTER_HEADER]?.trim();
  if (!value) return undefined;
  if (DELAY_SECONDS.test(value)) return Number(value) * 1000;
  if (!HTTP_DATE.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** What a request may carry beyond `fetch`'s own init. */
export interface ApiInit extends RequestInit {
  /**
   * What the caller reads of the envelope's `data`. A body that does not
   * match fails as `invalidResponse()`, and `data` is typed as its output.
   * Write it as a plain `z.object`, which drops the keys it does not name.
   */
  schema?: z.ZodType;
}

/**
 * One request and its envelope. Every failure is a `CustomError` carrying the
 * response status, the envelope's `code` and the `Retry-After` header, except
 * an abort, which rethrows as is for the caller that aborted it.
 *
 * With `schema`, `data` is its output. Without one only the envelope is
 * validated and `data` is the caller's `TData`, unchecked.
 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  init: ApiInit & { schema: S }
): Promise<ApiResult<z.output<S>>>;
export async function apiRequest<TData = unknown>(
  path: string,
  init?: RequestInit
): Promise<ApiResult<TData>>;
export async function apiRequest(
  path: string,
  init?: ApiInit
): Promise<ApiResult<unknown>>;
export async function apiRequest(
  path: string,
  { schema, ...init }: ApiInit = {}
): Promise<ApiResult<unknown>> {
  const response = await apiFetch(path, init);

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbort(error, init.signal)) throw error;
  }

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    if (response.ok) {
      logInvalidResponse(path, envelope.error);
      throw invalidResponse();
    }
    throw failure(failureMessage(response.status), response);
  }

  const { success, message, code, data, meta } = envelope.data;
  if (!success || !response.ok)
    throw failure(
      message || failureMessage(response.status),
      response,
      code,
      data
    );

  if (!schema) return { data, message, meta };
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    logInvalidResponse(path, parsed.error);
    throw invalidResponse();
  }
  return { data: parsed.data, message, meta };
}
