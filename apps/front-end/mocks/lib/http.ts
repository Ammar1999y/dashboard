import type { ResponseIssue } from '@app/shared/response-contract';
import type { EntityID } from '@app/shared/types';
import type { PaginationMeta } from '@app/shared/types/api';
import type * as z from 'zod';

import { HttpHandler, HttpResponse } from 'msw';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_DELETE_ERROR,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@app/shared/messages/common';
import { idRequired } from '@app/shared/messages/validation';
import {
  betterAuthResponseIssues,
  isBetterAuthResponseRoute,
  isResponseRoute,
  responseIssues,
  twoFactorChallengeIssues,
} from '@app/shared/response-contract';
import { validID } from '@app/shared/utils';
import { zodIssueMessage } from '@app/shared/validation/rules';
import { API_URL } from '@/lib/env';

/** The URL `apiFetch` and the auth client send `path` to. */
export const api = (path: string) => `${API_URL}${path}`;

export const ok = <T>(
  data: T,
  message: string = MSG_FETCHED,
  status: number = HTTP_STATUS.OK
) => HttpResponse.json({ success: true, message, data }, { status });

export const created = (id: string) =>
  ok({ id }, MSG_CREATED, HTTP_STATUS.CREATED);

/** One page: its rows as an array, or an object that holds them with more. */
export const okPage = <T>(page: { data: T; meta: PaginationMeta }) =>
  HttpResponse.json({ success: true, message: MSG_FETCHED, ...page });

/** `data` is a media refusal's blockers, which the server sends in place of `null`. */
export const fail = (
  status: number,
  message: string,
  code?: string,
  headers?: HeadersInit,
  data: unknown = null
) =>
  HttpResponse.json(
    { success: false, message, data, ...(code && { code }) },
    { status, headers }
  );

export const notFoundError = () =>
  new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

/** Narrows a parsed JSON body to a plain object; 400 for anything else. */
function requireJsonBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
  return body as Record<string, unknown>;
}

/** The body as a plain object, or the server's 400 for malformed JSON too. */
export async function readJson(
  request: Request
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return requireJsonBody(body);
}

/** `message` is the one text a route gives every body it refuses, in place of the issue's own. */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  message?: string
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CustomError(
      message ?? zodIssueMessage(parsed.error),
      HTTP_STATUS.UNPROCESSABLE
    );
  return parsed.data;
}

/** The body parsed by the schema the server parses it with: 400 before 422. */
export async function readJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  message?: string
): Promise<z.output<S>> {
  return parseOrThrow(schema, await readJson(request), message);
}

/** A canonical id, or the server's 422. */
export function requireId(value: unknown): EntityID {
  const id = validID(value);
  if (!id) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);
  return id;
}

// The server's routes pick their fallback by operation, which the method names.
const FALLBACK_MESSAGES = new Map<string, string>([
  ['GET', MSG_FETCH_ERROR],
  ['POST', MSG_CREATE_ERROR],
  ['PUT', MSG_UPDATE_ERROR],
  ['DELETE', MSG_DELETE_ERROR],
]);

/** What the server's `handleApiError` answers for `error`. */
export function errorResponse(
  error: unknown,
  fallbackMessage: string = MSG_INTERNAL_ERROR
): Response {
  if (error instanceof CustomError) {
    const status = error.status ?? HTTP_STATUS.INTERNAL_ERROR;
    if (status >= HTTP_STATUS.INTERNAL_ERROR)
      console.error('[mock api] server error response', error);
    return fail(
      status,
      error.message,
      error.code,
      error.responseHeaders,
      error.data ?? null
    );
  }
  console.error('[mock api] handler failed', error);
  return fail(HTTP_STATUS.INTERNAL_ERROR, fallbackMessage);
}

const AUTH_PREFIX = '/api/auth';

/** Where `body` breaks the contract published for `key`; `undefined` where none is. */
function contractIssues(
  key: string,
  path: string,
  body: unknown
): ResponseIssue[] | undefined {
  if (isResponseRoute(key)) return responseIssues(key, body);
  const subPath = path.startsWith(`${AUTH_PREFIX}/`)
    ? path.slice(AUTH_PREFIX.length)
    : undefined;
  if (subPath !== undefined && isBetterAuthResponseRoute(subPath))
    return betterAuthResponseIssues(subPath, body);
  // The server's hook answers the challenge from library routes too (`/sign-in/email`).
  if (body !== null && typeof body === 'object' && 'twoFactorRedirect' in body)
    return twoFactorChallengeIssues(body);
}

/**
 * Holds a 2xx JSON answer to what the server publishes for its route. A
 * mismatch throws under `bun test`, which fails the request, and is logged in
 * the browser.
 */
async function checkAnswer(
  method: string,
  pattern: string,
  response: Response
) {
  if (
    !response.ok ||
    !pattern.startsWith(API_URL) ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    return;
  const path = pattern
    .slice(API_URL.length)
    .split('/')
    // Every route key names its parameter `:id`.
    .map((segment) => (segment.startsWith(':') ? ':id' : segment))
    .join('/');
  const key = `${method} ${path}`;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    // Unreadable JSON is checked as no body, which every contract refuses.
    body = undefined;
  }
  const issues = contractIssues(key, path, body);
  if (!issues?.length) return;
  const where = issues
    .map(
      ({ path: at, code }) => `${at.map(String).join('.') || '(root)'} ${code}`
    )
    .join(', ');
  const report = `[mock api] ${key} answered outside its contract: ${where}`;
  if (process.env.NODE_ENV === 'test') throw new Error(report);
  console.error(report);
}

/**
 * `handler`, answering a throw with the API envelope instead of MSW's
 * `{ name, message, stack }` 500, and checking each 2xx answer against the
 * published contract. Applied at registration, so a handler module needs
 * nothing to be covered; `run` is the only public way in, as MSW keeps the
 * resolver protected.
 */
export function withApiErrors(handler: HttpHandler): HttpHandler {
  const { method, path } = handler.info;
  return new HttpHandler(method, path, async ({ request, requestId }) => {
    let result: Awaited<ReturnType<HttpHandler['run']>>;
    try {
      result = await handler.run({ request, requestId });
    } catch (error) {
      return errorResponse(error, FALLBACK_MESSAGES.get(request.method));
    }
    const response = result?.response;
    if (response && typeof path === 'string')
      await checkAnswer(request.method, path, response);
    return response;
  });
}

/** `{ success, message?, data? }`, which the project's Better Auth plugins answer with. */
export const pluginOk = (data?: unknown, message?: string) =>
  HttpResponse.json({
    success: true,
    ...(message && { message }),
    ...(data !== undefined && { data }),
  });

/**
 * `handler`, refusing in Better Auth's `{ code, message }` instead of the API
 * envelope, as every `/api/auth` route does except the forgot-password, OTP
 * and passwordless sends, which are the project's own routes.
 */
export function asPlugin(handler: HttpHandler): HttpHandler {
  const { method, path } = handler.info;
  return new HttpHandler(method, path, async ({ request, requestId }) => {
    try {
      const result = await handler.run({ request, requestId });
      return result?.response;
    } catch (error) {
      if (!(error instanceof CustomError)) throw error;
      return HttpResponse.json(
        { code: error.code ?? CUSTOM_AUTH_CODE, message: error.message },
        {
          status: error.status ?? HTTP_STATUS.INTERNAL_ERROR,
          headers: error.responseHeaders,
        }
      );
    }
  });
}
