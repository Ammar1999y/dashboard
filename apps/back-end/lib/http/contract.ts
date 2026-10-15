import type { HandlerCookieOptions } from './cookies';
import type { MediaRefusalData } from '@app/shared/responses/media';

/**
 * What a route is allowed to read from the request body — declared per route,
 * never inferred from the `Content-Type` the client sent, so the client cannot
 * pick the parser. A `none` route never touches the body stream at all.
 */
export type BodyPolicy = 'none' | 'json' | 'multipart';

/**
 * Everything about a request derivable from the head alone, so admission
 * checks can run before any body byte is read.
 */
export interface HandlerRequestMeta {
  query: URLSearchParams;
  /** Route params resolved by the adapter (e.g. `{ id: '...' }`). */
  params: Record<string, string>;
  headers: Headers;
  /** Absolute request URL. */
  url: string;
  method: string;
  /** Empty string when unknown. */
  ip: string;
  /** Persistence boundaries apply their own length caps. */
  userAgent: string | null;
  /** Pathname only, no host or query. */
  apiPath: string;
  /**
   * ⚠️ Only `headers`, `url` and `method` are safe to read: the body may
   * already have been consumed by `readJson()` or `readFormData()`, and a web
   * `Request` body reads once. Clone it at the call site if the raw body is
   * genuinely needed.
   */
  rawRequest: Request;
}

/** Framework-agnostic request context, built by the adapter layer. */
export interface HandlerInput extends HandlerRequestMeta {
  /**
   * The parsed JSON body, or null when the route's policy is not `json`, no
   * body was sent, the media type was not `application/json`, or parsing
   * failed. A function so nothing is read until the handler has run its own
   * admission checks; memoised.
   */
  readJson: () => Promise<unknown>;
  /**
   * The multipart form, or null when the route's policy is not `multipart` or
   * the media type was not `multipart/form-data`. A function for the same
   * reason as `readJson`; memoised.
   *
   * Parsed by the adapter rather than from `rawRequest`: on Elysia
   * `rawRequest.formData()` throws `Body has already been used`.
   */
  readFormData: () => Promise<FormData | null>;
}

export interface HandlerCookie {
  name: string;
  value: string;
  options?: HandlerCookieOptions;
}

interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
}

interface ErrorBody {
  success: false;
  message: string;
  code?: string;
  data: MediaRefusalData | null;
}

/**
 * For the few endpoints whose body shape an external consumer fixes and which
 * therefore cannot be the envelope: the Coolify health check and the OpenAPI
 * document. A separate output rather than `body: unknown`, so only a raw
 * contract entry's answer can carry a shape the envelope forbids.
 */
interface RawBody {
  raw: unknown;
}

interface OutputFields {
  status: number;
  headers?: Record<string, string>;
  /** Its own channel, because `Set-Cookie` is the one header that repeats. */
  cookies?: HandlerCookie[];
}

interface HandlerSuccess<
  B extends SuccessBody<unknown> = SuccessBody<unknown>,
> extends OutputFields {
  body: B;
}

export interface HandlerError extends OutputFields {
  body: ErrorBody;
}

export interface HandlerRaw extends OutputFields {
  body: RawBody;
}

export type HandlerOutput = HandlerSuccess | HandlerError | HandlerRaw;

export type SuccessOutput<T> = HandlerSuccess<SuccessBody<T>>;

function isRawBody(body: HandlerOutput['body']): body is RawBody {
  return 'raw' in body;
}

/** The value an adapter should JSON-serialise for a given output. */
export function responsePayload(body: HandlerOutput['body']): unknown {
  return isRawBody(body) ? body.raw : body;
}
