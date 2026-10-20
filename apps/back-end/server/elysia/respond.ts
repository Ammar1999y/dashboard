/**
 * The one exit every answer takes — queued cookies, the response policy, the
 * status the access log records, HEAD — and the after-response queue.
 *
 * A native `Response` (core's refusals, Better Auth) is finished here. A
 * binding's answer at a status its entry gives a schema stays a plain value
 * until Elysia serialises it, so that schema validates and strips it; its
 * headers go into `set.headers`, and are withdrawn if the schema refuses it.
 */
import type { HandlerCookie, HandlerOutput } from '@/lib/http/contract';

import { Elysia, status } from 'elysia';

import { HTTP_STATUS } from '@app/shared/http-status';

import { toAuthProblem } from '@/lib/auth/errors';
import { runAfterResponse } from '@/lib/http/after-response';
import { responsePayload } from '@/lib/http/contract';
import {
  drainQueuedCookies,
  parseSetCookieHeaders,
  queueResponseCookies,
  serializeSetCookie,
} from '@/lib/http/cookies';
import { toHeadResponse } from '@/lib/http/response';
import {
  applyResponsePolicy,
  applyResponsePolicyToBag,
} from '@/lib/http/response-policy';

/**
 * Request start times, for `Server-Timing` and the access log. Keyed by the
 * request, so it needs no framework support and cannot retain an entry for a
 * request whose response was never produced.
 */
const startedAt = new WeakMap<Request, number>();

/**
 * The status actually put on the wire for a native `Response`. A plain value's
 * is `set.status`, which Elysia fills from the `status()` it was returned with.
 */
const finalStatus = new WeakMap<Request, number>();

/**
 * The logged path of an answer the `request` hook gives itself. Elysia's own
 * `path` is cut from `request.url` by position, which is wrong when Bun left
 * that URL without an authority.
 */
const earlyLogPath = new WeakMap<Request, string>();

/**
 * OPTIONS requests past the host and length guards. Their answers skip the
 * exit step, as they did on Elysia 1: the preflight keeps exactly the headers
 * the CORS plugin and the `request` hook give it, and none is logged
 * (`reports/should-ignore.md` #66).
 */
const preflights = new WeakSet<Request>();

/** The policy a page route answers with in place of the API's CSP. */
const cspExemptions = new WeakMap<Request, string>();

export function exemptFromCsp(request: Request, policy: string): void {
  cspExemptions.set(request, policy);
}

export function markStarted(request: Request): void {
  startedAt.set(request, performance.now());
}

export function markPreflight(request: Request): void {
  preflights.add(request);
}

const elapsed = (request: Request): number | undefined => {
  const started = startedAt.get(request);
  return started === undefined ? undefined : performance.now() - started;
};

/** The single exit for a native `Response`. */
export function finish(request: Request, response: Response): Response {
  finalStatus.set(request, response.status);
  const own = new Set(
    parseSetCookieHeaders(response.headers.getSetCookie()).map(
      (cookie) => cookie.name
    )
  );
  const finished = applyResponsePolicy(response, {
    durationMs: elapsed(request),
    contentSecurityPolicy: cspExemptions.get(request),
  });
  for (const cookie of drainQueuedCookies(request.headers, own))
    finished.headers.append('set-cookie', serializeSetCookie(cookie));
  return finished;
}

/** An answer from the `request` hook; `mapResponse` and `afterResponse` still run. */
export function answerEarly(
  request: Request,
  logPath: string,
  response: Response
): Response {
  earlyLogPath.set(request, logPath);
  return response;
}

type HeaderRecord = Record<string, string | number | string[] | undefined>;

interface HeaderBag {
  headers: HeaderRecord;
}

/**
 * The bag before a value answer wrote into it, and every queued cookie it
 * took, including any its own cookies displaced.
 */
const valueAnswers = new WeakMap<
  Request,
  { before: HeaderRecord; queued: HandlerCookie[] }
>();

/**
 * A binding's answer, left a value so its response schema applies. Its own
 * cookie wins a name clash with a queued one: it was set after the read.
 */
export function answerValue(
  request: Request,
  set: HeaderBag,
  answer: HandlerOutput
) {
  const own = answer.cookies ?? [];
  const queued = drainQueuedCookies(request.headers);
  valueAnswers.set(request, { before: { ...set.headers }, queued });
  Object.assign(set.headers, answer.headers);
  const ownNames = new Set(own.map((cookie) => cookie.name));
  const cookies = [
    ...queued.filter((cookie) => !ownNames.has(cookie.name)),
    ...own,
  ];
  if (cookies.length > 0)
    set.headers['set-cookie'] = cookies.map(serializeSetCookie);
  return status(answer.status, responsePayload(answer.body));
}

/**
 * A value its response schema refused: the bag goes back to what it held
 * before the answer, so the 500 carries none of the answer's headers or
 * cookies, and the queued cookies return to the queue for the 500's exit.
 * Elysia merges `set.headers` into the 500 it is about to send.
 */
export function withdrawValue(request: Request, set: HeaderBag): void {
  const answered = valueAnswers.get(request);
  if (!answered) return;
  valueAnswers.delete(request);
  for (const name of Object.keys(set.headers))
    if (!Object.hasOwn(answered.before, name)) delete set.headers[name];
  Object.assign(set.headers, answered.before);
  queueResponseCookies(request.headers, answered.queued);
}

/**
 * `servedByPrefix` names the paths Better Auth owns, whose every refusal
 * carries `message` for its client: the library's own, and the ones this
 * server gives before, around or instead of it.
 */
export const exitStep = (servedByPrefix: (pathname: string) => boolean) =>
  new Elysia({ name: 'exit-step' })
    // After everything Elysia does, so a HEAD's answer is its GET's in every
    // branch — validated, refused, mapped or unrouted — with the body dropped.
    .wrap(
      (fetch) =>
        async (request: Request, ...rest: unknown[]): Promise<Response> => {
          let response = await fetch(request, ...rest);
          if (response.status >= HTTP_STATUS.BAD_REQUEST) {
            const pathname = URL.parse(request.url)?.pathname;
            if (pathname !== undefined && servedByPrefix(pathname))
              response = await toAuthProblem(response);
          }
          return request.method === 'HEAD'
            ? toHeadResponse(response)
            : response;
        }
    )
    // In addition to the `request` hook, not instead of it: a header on a
    // native `Response` wins over `set.headers`, so this runs last and
    // overwrites. See `lib/http/response-policy.ts`.
    .mapResponse(({ responseValue, request, set }) => {
      if (preflights.has(request)) return;
      if (responseValue instanceof Response)
        return finish(request, responseValue) as never;
      applyResponsePolicyToBag(set.headers, { durationMs: elapsed(request) });
    })
    .afterResponse(({ request, set, path, responseValue }) => {
      if (preflights.has(request)) return;
      const started = startedAt.get(request);
      startedAt.delete(request);
      runAfterResponse(request, {
        method: request.method,
        path: earlyLogPath.get(request) ?? path,
        status:
          finalStatus.get(request) ??
          (responseValue instanceof Response
            ? responseValue.status
            : typeof set.status === 'number'
              ? set.status
              : 200),
        durationMs: started === undefined ? 0 : performance.now() - started,
      });
      finalStatus.delete(request);
    })
    .as('global');
