import type { EntityID } from '@app/shared/types';
import type { PaginationMeta } from '@app/shared/types/api';
import type * as z from 'zod';

import { HttpHandler, HttpResponse } from 'msw';
import { CustomError } from '@app/shared/error-class';
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

export const okPage = <T>(page: { data: T[]; meta: PaginationMeta }) =>
  HttpResponse.json({ success: true, message: MSG_FETCHED, ...page });

export const fail = (status: number, message: string, code?: string) =>
  HttpResponse.json(
    { success: false, message, data: null, ...(code && { code }) },
    { status }
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

export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CustomError(
      zodIssueMessage(parsed.error),
      HTTP_STATUS.UNPROCESSABLE
    );
  return parsed.data;
}

/** The body parsed by the schema the server parses it with: 400 before 422. */
export async function readJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S
): Promise<z.output<S>> {
  return parseOrThrow(schema, await readJson(request));
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
    return fail(status, error.message, error.code);
  }
  console.error('[mock api] handler failed', error);
  return fail(HTTP_STATUS.INTERNAL_ERROR, fallbackMessage);
}

/**
 * `handler`, answering a throw with the API envelope instead of MSW's
 * `{ name, message, stack }` 500. Applied at registration, so a handler module
 * needs nothing to be covered; `run` is the only public way in, as MSW keeps
 * the resolver protected.
 */
export function withApiErrors(handler: HttpHandler): HttpHandler {
  const { method, path } = handler.info;
  return new HttpHandler(method, path, async ({ request, requestId }) => {
    try {
      const result = await handler.run({ request, requestId });
      return result?.response;
    } catch (error) {
      return errorResponse(error, FALLBACK_MESSAGES.get(request.method));
    }
  });
}
