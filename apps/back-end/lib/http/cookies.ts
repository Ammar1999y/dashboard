import type { HandlerCookie } from './contract';

/**
 * Outgoing cookie options. `extraFlags` and `extra` carry attributes the
 * adapter does not model (e.g. `Partitioned`, `Priority`) so they are
 * re-emitted verbatim instead of dropped.
 */
export interface HandlerCookieOptions {
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

/** Cookie attributes `HandlerCookieOptions` does not model, re-emitted verbatim. */
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

/**
 * `Set-Cookie`s produced below the handler — Better Auth's session reads —
 * which the adapter adds to every response for the request, error ones
 * included. ⚠️ Keyed by identity: the `Headers` object `HandlerInput.headers`
 * carries, never a copy of it.
 */
const queuedCookies = new WeakMap<Headers, Map<string, HandlerCookie>>();

/** Last write per name wins, so repeated session reads emit each cookie once. */
export function queueResponseCookies(
  requestHeaders: Headers,
  cookies: readonly HandlerCookie[]
): void {
  if (cookies.length === 0) return;
  const queue = queuedCookies.get(requestHeaders) ?? new Map();
  for (const cookie of cookies) queue.set(cookie.name, cookie);
  queuedCookies.set(requestHeaders, queue);
}

/**
 * Takes the request's queue, once: what a later exit drains is empty. Names in
 * `ownNames` are left out, because the response's own cookie was set after the
 * read that queued its namesake.
 */
export function drainQueuedCookies(
  requestHeaders: Headers,
  ownNames: ReadonlySet<string> = new Set()
): HandlerCookie[] {
  const queue = queuedCookies.get(requestHeaders);
  queuedCookies.delete(requestHeaders);
  if (!queue) return [];
  return queue
    .values()
    .filter((cookie) => !ownNames.has(cookie.name))
    .toArray();
}
