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
 * (`boundedBody`), so this is never the bound on what is buffered.
 */
export const SERVER_BODY_LIMIT_BYTES = 2 * MAX_REQUEST_BODY_BYTES;

/**
 * Default ceiling on a body parsed into memory, separate from
 * `MAX_REQUEST_BODY_BYTES` so no JSON route inherits the multipart allowance:
 * `JSON.parse` is synchronous and stalls every other in-flight request for as
 * long as it takes. A route that needs more sets `maxJsonBodyBytes` rather than
 * raising this.
 *
 * The largest real bodies are a few KB (a permission matrix, 50 ids, a passkey
 * attestation). At 1 MiB a crafted body cost 20–65 ms of parse a request, and
 * Better Auth parses before its session check, so anonymously.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Parts a form may show before its reader refuses it, counted as the body
 * streams: the parser builds every part before a handler can look,
 * and a 10 MB body holds about 200,000 empty ones. Above the one file an upload
 * takes, so the handler still names an ordinary stray field.
 */
export const MAX_MULTIPART_PARTS = 8;

/** One `; name=value` of a Content-Type (RFC 9110 §5.6.6), possibly empty. */
const MEDIA_TYPE_PARAMETER =
  // eslint-disable-next-line security/detect-unsafe-regex -- the quoted value's two branches cannot start on the same character, so its repetition never backtracks; measured linear to 100k-character headers
  /\s*;\s*(?:([^\s;=]+)=("(?:[^"\\]|\\.)*"|[^\s;"]*))?\s*/y;

/**
 * RFC 2046 `bchars`, the space allowed but not last. ASCII only, so the bytes
 * counted are the bytes the parser splits on whatever encoding either picks.
 */
const BOUNDARY_VALUE = /^[\w'()+,./:=? -]*[\w'()+,./:=?-]$/;

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
 * `read`, or `refusal()` once `ms` pass first, so a caller holding a slot
 * over the read can give the slot back: an idle timeout resets on every byte,
 * and a trickled body would otherwise hold it for good. The read is only no
 * longer waited for; Bun ends the request's body once the response is sent.
 */
export async function readWithin<T>(
  read: Promise<T>,
  ms: number,
  refusal: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(refusal()), ms);
  });
  // The read may still fail after the deadline answered for it.
  void read.catch(() => null);
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
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
 * The request body, unable to exceed `maxBytes`, each chunk shown to `inspect`
 * before it passes. Internal: the count happens inside the stream, so where the
 * refusal surfaces depends on the reader.
 */
function boundedBody(
  request: Request,
  maxBytes: number,
  inspect?: (chunk: Uint8Array) => void
): ReadableStream<Uint8Array> | null {
  if (declaresBodyOver(request, maxBytes)) throw bodyTooLarge();

  const body = request.body;
  if (!body) return null;

  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        // Throwing errors the stream, which cancels the source: the rest of the
        // upload stops instead of being drained after it was rejected.
        if (total > maxBytes) throw bodyTooLarge();
        inspect?.(chunk);
        controller.enqueue(chunk);
      },
    })
  );
}

/**
 * The request body as text, refusing anything over `maxBytes` — through
 * `boundedBody`, so the reader-side and hand-it-on ceilings are one
 * implementation.
 */
async function readBoundedText(
  request: Request,
  maxBytes: number
): Promise<string> {
  const body = boundedBody(request, maxBytes);
  if (!body) return '';
  return await new Response(body).text();
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
 * over-size one is the 413 and one past `MAX_MULTIPART_PARTS` the 400 the
 * counters raised: the parser rejects with the stream's own error.
 *
 * ⚠️ Parsed with the boundary named here, never through `Request.formData()`:
 * that picks its parser from the whole header, and one carrying the URL-encoded
 * media type anywhere, the boundary included, reads the body as URL-encoded
 * pairs no part count sees. An empty boundary would do the same, so none
 * reaches the parser.
 */
async function safeReadFormData(
  request: Request,
  maxBytes: number
): Promise<FormData | null> {
  const boundary = multipartBoundary(request.headers.get('content-type') ?? '');
  if (boundary === null) return null;
  const body = boundedBody(request, maxBytes, partCounter(boundary));
  if (!body) return null;
  try {
    return await Bun.readableStreamToFormData(body, boundary);
  } catch (error) {
    if (error instanceof CustomError) throw error;
    return null;
  }
}

/**
 * The first `boundary` parameter, or null, the body unread, for a header with
 * none, with one outside `BOUNDARY_VALUE`, or that does not parse whole.
 */
function multipartBoundary(contentType: string): string | null {
  const start = contentType.indexOf(';');
  if (start === -1) return null;
  const parameters = new RegExp(MEDIA_TYPE_PARAMETER);
  parameters.lastIndex = start;
  let boundary: string | undefined;
  while (parameters.lastIndex < contentType.length) {
    const parameter = parameters.exec(contentType);
    if (!parameter) return null;
    const [, name = '', value = ''] = parameter;
    if (boundary === undefined && name.toLowerCase() === 'boundary')
      boundary = value.startsWith('"')
        ? value.slice(1, -1).replaceAll(/\\(.)/g, '$1')
        : value;
  }
  return boundary !== undefined && BOUNDARY_VALUE.test(boundary)
    ? boundary
    : null;
}

/**
 * Refuses a form once it opens more than `MAX_MULTIPART_PARTS` parts. The
 * parser opens one at every `--boundary` followed by a CRLF, whatever precedes
 * it, so exactly that is counted: boundary text a file merely contains is not.
 * An all-hyphen boundary's closing line holds an opening too, so such a form
 * reaches the ceiling one part early: the safe side.
 */
function partCounter(boundary: string): (chunk: Uint8Array) => void {
  const opening = Buffer.from(`--${boundary}\r\n`);
  let carry = Buffer.alloc(0);
  let opened = 0;
  return (chunk) => {
    // The carry is shorter than an opening, so a match starting in it was
    // never counted: it is the one a chunk boundary cut.
    const scanned = Buffer.concat([carry, chunk]);
    let at = scanned.indexOf(opening);
    while (at !== -1) {
      opened += 1;
      if (opened > MAX_MULTIPART_PARTS) throw malformedBody();
      at = scanned.indexOf(opening, at + opening.length);
    }
    const kept = Math.max(0, scanned.length - opening.length + 1);
    carry = Buffer.from(scanned.subarray(kept));
  };
}
