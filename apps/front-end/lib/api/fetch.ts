import type * as z from 'zod';

import { problemSchema } from '@app/shared/api/wire';
import { CustomError } from '@app/shared/error-class';
import { INVALID_RESPONSE_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_BODY_TOO_LARGE,
  MSG_SERVICE_UNAVAILABLE,
  MSG_TOO_MANY_REQUESTS,
} from '@app/shared/messages/common';
import { MSG_OFFLINE, MSG_UNEXPECTED_ERROR } from '@/constants/messages';

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

/**
 * A refusal as the `CustomError` the app branches on: the problem's `detail`,
 * `code` and media ids, and the `Retry-After` header. A body that is not a
 * problem, such as a proxy's error page, gets the status's own text.
 */
export function refusalOf(response: Response, body: unknown): CustomError {
  const problem = problemSchema.safeParse(body);
  const { detail, code, data } = problem.success ? problem.data : {};
  const error = new CustomError(
    detail || failureMessage(response.status),
    response.status,
    code,
    data
  );
  const retryAfter = response.headers.get(RETRY_AFTER_HEADER);
  if (retryAfter !== null)
    error.responseHeaders = { [RETRY_AFTER_HEADER]: retryAfter };
  return error;
}

/** The answer's JSON; `undefined` when it has none. An abort rethrows as is. */
export async function readBody(
  response: Response,
  signal: AbortSignal | null | undefined
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    return undefined;
  }
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
