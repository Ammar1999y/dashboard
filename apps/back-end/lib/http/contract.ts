import type { ApiEnvelope } from '@app/shared/types/api';

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

/**
 * Outgoing cookie options. `extraFlags` and `extra` carry attributes the
 * adapter does not model (e.g. `Partitioned`, `Priority`) so they are
 * re-emitted verbatim instead of dropped.
 */
interface HandlerCookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  expires?: Date;
  extraFlags?: string[];
  extra?: Record<string, string>;
}

export interface HandlerCookie {
  name: string;
  value: string;
  options?: HandlerCookieOptions;
}

/**
 * For the few endpoints whose body shape an external consumer fixes and which
 * therefore cannot be the envelope: the Coolify health check and the scheduled
 * sweep. A separate union member rather than `body: unknown`, so an ordinary
 * handler has to call `apiRaw` to return a shape the contract forbids.
 */
interface HandlerRawBody {
  raw: unknown;
}

type HandlerBody<T = unknown> = ApiEnvelope<T> | HandlerRawBody;

function isRawBody(body: HandlerBody): body is HandlerRawBody {
  return 'raw' in body;
}

/** The value an adapter should JSON-serialise for a given output. */
export function responsePayload(body: HandlerBody): unknown {
  return isRawBody(body) ? body.raw : body;
}

export interface HandlerOutput<T = unknown> {
  status: number;
  body: HandlerBody<T>;
  headers?: Record<string, string>;
  /** Its own channel, because `Set-Cookie` is the one header that repeats. */
  cookies?: HandlerCookie[];
}

export type Handler = (ctx: HandlerInput) => Promise<HandlerOutput>;

/** Cookie attributes this module does not model, re-emitted verbatim. */
interface UnmodelledAttributes {
  flags: string[];
  pairs: Record<string, string>;
}

function applyCookieAttribute(
  attr: string,
  options: HandlerCookieOptions,
  unmodelled: UnmodelledAttributes
): void {
  const eq = attr.indexOf('=');
  const k = eq === -1 ? attr : attr.slice(0, eq);
  const v = eq === -1 ? '' : attr.slice(eq + 1);
  switch (k.toLowerCase()) {
    case 'path': {
      options.path = v;
      return;
    }
    case 'domain': {
      options.domain = v;
      return;
    }
    case 'max-age': {
      options.maxAge = Number(v);
      return;
    }
    case 'expires': {
      options.expires = new Date(v);
      return;
    }
    case 'httponly': {
      options.httpOnly = true;
      return;
    }
    case 'secure': {
      options.secure = true;
      return;
    }
    case 'samesite': {
      const s = v.toLowerCase();
      // eslint-disable-next-line unicorn/prefer-includes-over-repeated-comparisons
      if (s === 'strict' || s === 'lax' || s === 'none') options.sameSite = s;
      return;
    }
    default: {
      if (eq === -1) unmodelled.flags.push(k);
      else unmodelled.pairs[k] = v;
    }
  }
}

/**
 * Parses raw `Set-Cookie` values (e.g. from Better Auth's
 * `returnHeaders: true`), keeping unmodelled attributes on
 * `options.extraFlags` / `options.extra`.
 */
export function parseSetCookieHeaders(values: string[]): HandlerCookie[] {
  const parsed: HandlerCookie[] = [];
  for (const raw of values) {
    const segments = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const [nameValue, ...attrs] = segments;
    if (!nameValue) continue;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);
    const options: HandlerCookieOptions = {};
    const unmodelled: UnmodelledAttributes = { flags: [], pairs: {} };
    for (const attr of attrs) applyCookieAttribute(attr, options, unmodelled);
    if (unmodelled.flags.length > 0) options.extraFlags = unmodelled.flags;
    if (Object.keys(unmodelled.pairs).length > 0)
      options.extra = unmodelled.pairs;
    parsed.push({ name, value, options });
  }
  return parsed;
}

/**
 * Renders a `HandlerCookie` back into one `Set-Cookie` value — the inverse of
 * `parseSetCookieHeaders`, kept beside it so the two cannot drift.
 *
 * Name and value are emitted VERBATIM: most of these cookies arrive as an
 * already-formed `Set-Cookie` line from Better Auth, and percent-encoding them
 * would corrupt a signed session token.
 */
export function serializeSetCookie(cookie: HandlerCookie): string {
  const o = cookie.options ?? {};
  const parts = [`${cookie.name}=${cookie.value}`];

  // eslint-disable-next-line unicorn/no-immediate-mutation -- eight optional attributes, each behind its own condition and one behind a comment; a single literal would read worse than the chain
  if (o.maxAge !== undefined && Number.isFinite(o.maxAge))
    parts.push(`Max-Age=${Math.trunc(o.maxAge)}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.path) parts.push(`Path=${o.path}`);
  // An unparsable date would serialise as "Invalid Date", which browsers treat
  // as a session cookie — silently turning a deletion into a live cookie.
  if (o.expires && !Number.isNaN(o.expires.getTime()))
    parts.push(`Expires=${o.expires.toUTCString()}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite)
    parts.push(
      `SameSite=${o.sameSite[0]?.toUpperCase() ?? ''}${o.sameSite.slice(1)}`
    );
  const extraFlags = o.extraFlags ?? [];
  const extraAttributes = Object.entries(o.extra ?? {});
  for (const flag of extraFlags) parts.push(flag);
  for (const [key, value] of extraAttributes) parts.push(`${key}=${value}`);

  return parts.join('; ');
}
