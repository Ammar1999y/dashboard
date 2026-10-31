import type { BodyPolicy, HandlerRequestMeta } from './contract';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_BODY_TOO_LARGE } from '@app/shared/messages/common';
import { normalizeMimeType } from '@app/shared/validation/media-types';

import { getClientIp } from './client-ip';
import { malformedBody, requireJsonBody } from './input';

const JSON_TYPE = 'application/json';
const MULTIPART_TYPE = 'multipart/form-data';

/**
 * Bounds framework buffering before route-specific payload validation. Sized
 * for the largest admitted file (`MAX_DOCUMENT_SIZE_MB`) plus multipart
 * framing; every per-file cap is enforced again inside the handler.
 *
 * Here rather than in `app.ts` so the OpenAPI generator can publish it without
 * importing the framework file.
 */
export const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024;

/**
 * Bun's own `maxRequestBodySize`, kept ABOVE every ceiling the app enforces.
 * At or below one, Bun answers a declared over-size body itself, before any
 * hook runs: a bare 413 with no CORS header, no problem body and no access
 * line, which a cross-origin page sees as a network error. Between the two,
 * the app's head check answers and Bun drains the unread body, which is what
 * lets a browser still uploading read that answer.
 *
 * Every reader counts its own bytes against the route's ceiling
 * (`boundRequestBody`), so this is never the bound on what is buffered.
 */
export const SERVER_BODY_LIMIT_BYTES = 2 * MAX_REQUEST_BODY_BYTES;

/**
 * Default ceiling on a body parsed into memory, separate from
 * `MAX_REQUEST_BODY_BYTES` so no JSON route inherits the multipart allowance:
 * `JSON.parse` is synchronous and stalls every other in-flight request for as
 * long as it takes. A route that needs more sets `maxJsonBodyBytes` rather than
 * raising this.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Builds the head-only part of the request context — no body byte is read. */
export function buildRequestMeta(request: Request): HandlerRequestMeta {
  return {
    headers: request.headers,
    url: request.url,
    method: request.method,
    // TODO(proxy-trust): a trusted header validated by syntax only — see the
    // note on TRUSTED_IP_HEADERS in ./client-ip.ts.
    ip: getClientIp(request.headers) ?? '',
    userAgent: request.headers.get('user-agent'),
    apiPath: new URL(request.url).pathname,
    rawRequest: request,
  };
}

/**
 * A multipart route's form, read when the handler asks, so "check, then read"
 * holds even for routes whose limiter lives inside the handler. Null, with the
 * stream untouched, for a method without a body or another media type, so a
 * client cannot pick the parser. Memoised: a web `Request` body reads once,
 * and the first result, the `null` of a malformed body included, is kept.
 *
 * The caller must hand over an unread body; on Elysia that means registering
 * the route with `parse: 'none'`.
 */
export function lazyFormData(request: Request): () => Promise<FormData | null> {
  // ⚠️ Case-insensitive matching only agrees with `Request.formData()` at or
  // above the runtime floor `server.ts` asserts;
  // `tests/unit/request-body-policy.test.ts` holds the cases that fail if that
  // floor is lowered.
  const essence = normalizeMimeType(request.headers.get('content-type') ?? '');
  if (essence !== MULTIPART_TYPE || !methodCanHaveBody(request.method))
    return () => Promise.resolve(null);

  let pending: Promise<FormData | null> | null = null;
  return () => (pending ??= safeReadFormData(request, MAX_REQUEST_BODY_BYTES));
}

function methodCanHaveBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

export function bodyTooLarge(): CustomError {
  return new CustomError(MSG_BODY_TOO_LARGE, HTTP_STATUS.CONTENT_TOO_LARGE);
}

/**
 * The ceiling a body may not cross, decided by the POLICY the route declares —
 * never by the `Content-Type` the caller sent, which would hand the upload
 * allowance to anyone who writes `multipart/form-data` on a sign-in.
 */
export function bodyPolicyCeiling(
  policy: BodyPolicy,
  maxJsonBodyBytes: number = MAX_JSON_BODY_BYTES
): number {
  return policy === 'multipart' ? MAX_REQUEST_BODY_BYTES : maxJsonBodyBytes;
}

/**
 * Does the request SAY it is over the ceiling? A shortcut, never the control: a
 * chunked request declares no length. Its value is position — it answers from
 * the head alone, before a byte is read.
 */
export function declaresBodyOver(request: Request, maxBytes: number): boolean {
  const declared = Number(request.headers.get('content-length'));
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * The same request with a body that cannot exceed `maxBytes`. Internal: the
 * count happens inside the stream, so where the refusal surfaces depends on the
 * reader. `boundedBodyRequest` is the version for handing a request on.
 */
function boundRequestBody(request: Request, maxBytes: number): Request {
  if (declaresBodyOver(request, maxBytes)) throw bodyTooLarge();

  const body = request.body;
  if (!body) return request;

  let total = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        // Throwing errors the stream, which cancels the source: the rest of the
        // upload stops instead of being drained after it was rejected.
        if (total > maxBytes) throw bodyTooLarge();
        controller.enqueue(chunk);
      },
    })
  );

  // Bun's `RequestInit` does not declare `duplex`, which a streamed body needs.
  const init: RequestInit & { duplex: 'half' } = {
    body: counted,
    duplex: 'half',
  };
  // The original `Content-Length` would describe neither what is sent nor what
  // is read, so it goes with the original body.
  return new Request(request, init);
}

/**
 * The request body as text, refusing anything over `maxBytes` — through
 * `boundRequestBody`, so the reader-side and hand-it-on ceilings are one
 * implementation.
 */
async function readBoundedText(
  request: Request,
  maxBytes: number
): Promise<string> {
  const bounded = boundRequestBody(request, maxBytes);
  if (!bounded.body) return '';
  return await bounded.text();
}

/**
 * The request, rebuilt with a body this process has already bounded — for a
 * consumer that reads the body itself, such as `auth.handler`.
 *
 * Buffered rather than piped so the 413 is raised here, where the caller can
 * catch it: a stream erroring inside Better Auth surfaces as a 413 or a 500
 * depending on where its parse happens to be. The consumer buffers the same
 * bytes anyway.
 *
 * ⚠️ Text only: every mount it serves must take a text body, which is why it
 * is not applied to `multipart`.
 */
export async function boundedBodyRequest(
  request: Request,
  maxBytes: number
): Promise<Request> {
  if (!request.body) return request;
  return new Request(request, {
    // eslint-disable-next-line unicorn/no-invalid-fetch-options -- the rule cannot see that the guard above excludes GET and HEAD, the only methods a body is invalid on: a `Request` of either never has one
    body: await readBoundedText(request, maxBytes),
  });
}

function parsedOrNull(text: string): unknown {
  try {
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A binding's JSON body, read once its admission has passed: 400 for another
 * media type or an empty, malformed or non-object body, as the lazy reader
 * answers, and 413 the moment the count passes `maxBytes`.
 *
 * The media-type refusal is also the CSRF layer `app.ts` counts on: a body a
 * cross-site form can send without a preflight never reaches a JSON handler.
 */
export async function readJsonObject(
  request: Request,
  maxBytes: number
): Promise<Record<string, unknown>> {
  try {
    const essence = normalizeMimeType(
      request.headers.get('content-type') ?? ''
    );
    if (essence !== JSON_TYPE) throw malformedBody();
    return requireJsonBody(
      parsedOrNull(await readBoundedText(request, maxBytes))
    );
  } catch (error) {
    if (error instanceof CustomError) throw new UnreadableBody(error);
    throw error;
  }
}

/**
 * `readJsonObject`'s refusal, typed apart from the admission refusals the same
 * framework hook raises, so a binding can answer it its own way
 * (`refusals.unreadableBody`); otherwise `refusal` is the answer.
 */
export class UnreadableBody extends Error {
  constructor(readonly refusal: CustomError) {
    super(refusal.message);
    this.name = 'UnreadableBody';
  }
}

/**
 * A malformed multipart body is "no form", not a 500; the handler decides. An
 * over-size one is the 413 the counter raised: `formData()` rejects with the
 * stream's own error.
 */
async function safeReadFormData(
  request: Request,
  maxBytes: number
): Promise<FormData | null> {
  try {
    return await boundRequestBody(request, maxBytes).formData();
  } catch (error) {
    if (error instanceof CustomError) throw error;
    return null;
  }
}
