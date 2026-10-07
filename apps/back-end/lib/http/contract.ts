import type { HandlerCookieOptions } from './cookies';
import type {
  PaginatedRoute,
  ResponseData,
  ResponseRoute,
} from '@app/shared/response-contract';
import type { PaginationMeta } from '@app/shared/types/api';

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

/**
 * What a handler may hand the serialiser where the wire carries `T`: a `Date`
 * wherever `T` is a plain `string`, because `Response.json` writes it as one.
 * Literal and enum strings keep their exact type.
 */
export type ServerValue<T> = T extends string
  ? string extends T
    ? T | Date
    : T
  : T extends readonly (infer Element)[]
    ? readonly ServerValue<Element>[]
    : T extends object
      ? { [K in keyof T]: ServerValue<T[K]> }
      : T;

interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
}

interface PaginatedBody<T> extends SuccessBody<T> {
  meta: PaginationMeta;
}

interface ErrorBody {
  success: false;
  message: string;
  code?: string;
  data: null;
}

/**
 * For the few endpoints whose body shape an external consumer fixes and which
 * therefore cannot be the envelope: the Coolify health check and the scheduled
 * sweep. A separate output rather than `body: unknown`, so an ordinary handler
 * has to call `apiRaw` to return a shape the contract forbids, and a keyed one
 * cannot at all.
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

export type PaginatedOutput<T> = HandlerSuccess<PaginatedBody<T>>;

function isRawBody(body: HandlerOutput['body']): body is RawBody {
  return 'raw' in body;
}

/** The value an adapter should JSON-serialise for a given output. */
export function responsePayload(body: HandlerOutput['body']): unknown {
  return isRawBody(body) ? body.raw : body;
}

type RouteBody<K extends ResponseRoute> = K extends PaginatedRoute
  ? PaginatedBody<ServerValue<ResponseData<K>>>
  : SuccessBody<ServerValue<ResponseData<K>>> & { meta?: never };

/** What a handler keyed `K` may return: its success envelope, or a refusal. */
export type RouteOutput<K extends ResponseRoute> =
  HandlerSuccess<RouteBody<K>> | HandlerError;

export interface Handler {
  (ctx: HandlerInput): Promise<HandlerOutput>;
  /** Stamped by the keyed wrappers; the document build holds it to the row. */
  readonly routeKey?: ResponseRoute;
}

export interface RouteHandler<K extends ResponseRoute> {
  (ctx: HandlerInput): Promise<RouteOutput<K>>;
  readonly routeKey: K;
}
