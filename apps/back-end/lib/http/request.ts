import type { BodyPolicy, HandlerInput, HandlerRequestMeta } from './contract';

import { HTTP_STATUS, MSG_BODY_TOO_LARGE } from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { normalizeMimeType } from '@app/shared/validation/media-types';

import { getClientIp } from './client-ip';

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
 * Default ceiling on a body parsed into memory, separate from
 * `MAX_REQUEST_BODY_BYTES` so no JSON route inherits the multipart allowance:
 * `JSON.parse` is synchronous and stalls every other in-flight request for as
 * long as it takes. A route that needs more sets `maxJsonBodyBytes` rather than
 * raising this.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** Builds the head-only part of the request context — no body byte is read. */
export function buildRequestMeta(
  request: Request,
  params: Record<string, string> = {}
): HandlerRequestMeta {
  const url = new URL(request.url);

  return {
    query: url.searchParams,
    params,
    headers: request.headers,
    url: request.url,
    method: request.method,
    // TODO(proxy-trust): a trusted header validated by syntax only — see the
    // note on TRUSTED_IP_HEADERS in ./client-ip.ts.
    ip: getClientIp(request.headers) ?? '',
    userAgent: request.headers.get('user-agent'),
    apiPath: url.pathname,
    rawRequest: request,
  };
}

/**
 * Completes a `HandlerRequestMeta` into a `HandlerInput` under the route's
 * declared body policy.
 *
 * Synchronous, and it reads nothing: both readers are lazy, so "check, then
 * read" holds even for routes whose limiter lives inside the handler. The
 * policy decides what is readable at all — a `json` route's `readFormData()`
 * returns null whatever the client sent, and vice versa.
 *
 * The caller must hand over an unread body; on Elysia that means registering
 * the route with `parse: 'none'`.
 */
export function withBodyPolicy(
  meta: HandlerRequestMeta,
  policy: BodyPolicy,
  maxJsonBodyBytes: number = MAX_JSON_BODY_BYTES
): HandlerInput {
  const request = meta.rawRequest;
  const canHaveBody = methodCanHaveBody(meta.method);
  // ⚠️ Case-insensitive matching only agrees with `Request.formData()` at or
  // above the runtime floor `server.ts` asserts;
  // `tests/unit/request-body-policy.test.ts` holds the cases that fail if that
  // floor is lowered.
  const essence = normalizeMimeType(request.headers.get('content-type') ?? '');

  const jsonAllowed = policy === 'json' && canHaveBody && essence === JSON_TYPE;
  const multipartAllowed =
    policy === 'multipart' && canHaveBody && essence === MULTIPART_TYPE;

  return {
    ...meta,
    readJson: memoise(jsonAllowed, () =>
      safeReadJson(request, maxJsonBodyBytes)
    ),
    readFormData: memoise(multipartAllowed, () => safeReadFormData(request)),
  };
}

/**
 * A web `Request` body reads exactly once, so the first result is cached,
 * including the `null` a malformed body produces. A forbidden read is a
 * constant `null` that never touches the stream.
 */
function memoise<T>(
  allowed: boolean,
  read: () => Promise<T | null>
): () => Promise<T | null> {
  if (!allowed) return () => Promise.resolve(null);

  let pending: Promise<T | null> | null = null;
  return () => {
    pending ??= read();
    return pending;
  };
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

/**
 * Reads a JSON body; null on an empty or malformed body, which
 * `requireJsonBody` turns into a 400. An over-size body is the one case that
 * throws, because a 413 is not the same answer as "unparseable".
 */
async function safeReadJson(
  request: Request,
  maxBytes: number
): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  try {
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A malformed multipart body is "no form", not a 500; the handler decides. */
async function safeReadFormData(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
