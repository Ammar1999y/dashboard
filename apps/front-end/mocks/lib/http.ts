import type { ResponseIssue } from '@app/shared/api/issues';
import type { MediaRefusalData } from '@app/shared/responses/media';
import type { EntityID } from '@app/shared/types';
import type * as z from 'zod';

import { HttpHandler, HttpResponse } from 'msw';
import * as authEndpoints from '@app/shared/api/auth';
import { BETTER_AUTH_PREFIX } from '@app/shared/api/endpoint';
import { twoFactorChallengeIssues } from '@app/shared/api/issues';
import {
  PROBLEM_MEDIA_TYPE,
  problemBody,
  problemSchema,
} from '@app/shared/api/wire';
import { CustomError } from '@app/shared/error-class';
import { CUSTOM_AUTH_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_CREATE_ERROR,
  MSG_DELETE_ERROR,
  MSG_FETCH_ERROR,
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

const asProblem = (body: object, status: number, headers?: HeadersInit) => {
  const sent = new Headers(headers);
  sent.set('content-type', PROBLEM_MEDIA_TYPE);
  return HttpResponse.json(body, { status, headers: sent });
};

/** `data` is a media refusal's blockers, for the codes that name them. */
export const fail = (
  status: number,
  message: string,
  code?: string,
  headers?: HeadersInit,
  data?: MediaRefusalData
) => asProblem(problemBody(status, message, code, data), status, headers);

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

/**
 * A route's own 500 text for a throw that is not a refusal, as the server's
 * binding `failure` option gives one: `promise.catch(failingAs(message))`.
 */
export const failingAs =
  (message: string) =>
  (error: unknown): never => {
    if (error instanceof CustomError) throw error;
    console.error('[mock api] handler failed', error);
    throw new CustomError(message, HTTP_STATUS.INTERNAL_ERROR);
  };

/** What the server's `handleApiError` answers for `error`. */
function errorResponse(
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
      error.data
    );
  }
  console.error('[mock api] handler failed', error);
  return fail(HTTP_STATUS.INTERNAL_ERROR, fallbackMessage);
}

/** Ours, although they sit under the Better Auth prefix. */
const AUTH_BINDING_PATHS: ReadonlySet<string> = new Set(
  Object.values(authEndpoints).map(({ path }) => path)
);

/** The server's `servedByPrefix`: a path Better Auth owns, not a binding. */
const servedByBetterAuth = (path: string) =>
  path.startsWith(`${BETTER_AUTH_PREFIX}/`) && !AUTH_BINDING_PATHS.has(path);

/**
 * The server's `toAuthProblem`: a refusal where Better Auth answers repeats
 * `detail` as `message`, which Better Auth's client reads, and always has a
 * `code`.
 */
async function toAuthProblem(response: Response): Promise<Response> {
  if (response.ok) return response;
  const problem = problemSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null)
  );
  if (!problem.success) return response;
  const { status, detail, code } = problem.data;
  return asProblem(
    {
      ...problemBody(status, detail, code ?? CUSTOM_AUTH_CODE),
      message: detail,
    },
    status,
    response.headers
  );
}

/**
 * Where an answer `mock()` does not hold breaks what the server publishes:
 * only the challenge the server's hook answers from library routes
 * (`/sign-in/email`), whose own bodies are the library's.
 */
function contractIssues(body: unknown): ResponseIssue[] | undefined {
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
  const path = pattern.slice(API_URL.length);
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    // Unreadable JSON is checked as no body, which every contract refuses.
    body = undefined;
  }
  const issues = contractIssues(body);
  if (issues?.length) reportOutsideContract(`${method} ${path}`, issues);
}

/** A mock that answered outside its contract: a bug in the mock, never a refusal. */
class ContractBreak extends Error {}

/**
 * Throws under `bun test`, which fails the request and, through MSW's
 * `unhandledException`, the test; logs in the browser.
 */
export function reportOutsideContract(
  key: string,
  issues: readonly ResponseIssue[]
) {
  if (issues.length === 0) return;
  const where = issues
    .map(
      ({ path: at, code }) => `${at.map(String).join('.') || '(root)'} ${code}`
    )
    .join(', ');
  const report = `[mock api] ${key} answered outside its contract: ${where}`;
  if (process.env.NODE_ENV === 'test') throw new ContractBreak(report);
  console.error(report);
}

/** `mock()` handlers, which hold their answer to their entry themselves. */
export const checkedByEntry = new WeakSet<HttpHandler>();

/**
 * `handler`, answering a throw with a problem instead of MSW's
 * `{ name, message, stack }` 500, refusing where Better Auth answers in its
 * client's shape, and checking each 2xx answer against the published
 * contract. Applied at registration, so a handler module needs nothing to be
 * covered; `run` is the only public way in, as MSW keeps the resolver
 * protected.
 */
export function withApiErrors(handler: HttpHandler): HttpHandler {
  const { method, path } = handler.info;
  return new HttpHandler(method, path, async ({ request, requestId }) => {
    let response: Response | undefined;
    try {
      const result = await handler.run({ request, requestId });
      response = result?.response;
    } catch (error) {
      if (error instanceof ContractBreak) throw error;
      response = errorResponse(error, FALLBACK_MESSAGES.get(request.method));
    }
    if (!response) return;
    if (servedByBetterAuth(new URL(request.url).pathname))
      response = await toAuthProblem(response);
    if (typeof path === 'string' && !checkedByEntry.has(handler))
      await checkAnswer(request.method, path, response);
    return response;
  });
}
