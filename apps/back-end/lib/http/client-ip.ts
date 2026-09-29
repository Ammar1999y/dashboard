import * as z from 'zod';

import { IP_ADDRESS_MAX } from '@/lib/audit/constants';

/**
 * Trusted edge headers. Shared with Better Auth
 * (`advanced.ipAddress.ipAddressHeaders`) so our limiters, Better Auth's limiter
 * and session IP metadata all read the same source instead of Better Auth
 * defaulting to `x-forwarded-for`. A header nothing in front of the origin sets
 * is attack surface: a forged value is accepted on syntax alone.
 *
 * TODO(proxy-trust): nothing checks that the socket peer is the expected
 * upstream, so a request that reaches the origin directly can forge this
 * header. Resolve once the edge is final and its proxy CIDRs are known:
 * `server.requestIP(request)` asserts the PROXY, and does not replace this
 * header rule.
 */
export const TRUSTED_IP_HEADERS = ['cf-connecting-ip'] as const;

// Compiled because no caller reads the parsed value or the issues, so
// `validate` may stop at the first failure. A user callback (`.refine`,
// `z.preprocess`) clears the compiled parser's `definite` flag and silently
// sends every rejection back through a full runtime re-parse.
const IP_SCHEMA = z.compile(z.union([z.ipv4(), z.ipv6()]));

/**
 * The identifier used when no trusted header is present in a development
 * process. Unreachable through a misspelt or absent `NODE_ENV`: `server.ts`
 * refuses anything but `development` / `test` / `production` before any
 * application module loads.
 *
 * Without it every `preAuthIpLimit` route answers 503 locally, because
 * `ipIdentifier` fails closed by design.
 */
const DEVELOPMENT_FALLBACK_IP = '127.0.0.1';

/**
 * Extracts the client IP from trusted proxy headers only.
 *
 * `x-forwarded-for` is intentionally NOT accepted — it is client-controllable
 * when the origin is directly reachable. Block direct-origin traffic at the
 * edge (Cloudflare-only ingress).
 *
 * TODO(proxy-trust): see the note on TRUSTED_IP_HEADERS.
 */
export function getClientIp(headers: Headers): string | null {
  const raw = headers.get(TRUSTED_IP_HEADERS[0]);

  if (raw && raw.length <= IP_ADDRESS_MAX && IP_SCHEMA.validate(raw))
    return raw;

  return process.env.NODE_ENV === 'development'
    ? DEVELOPMENT_FALLBACK_IP
    : null;
}
