/**
 * ⚠️ `body` feeds the published OpenAPI document: `lib/http/openapi/` renders
 * the library's generated request body for an endpoint with no
 * `BETTER_AUTH_BODIES` entry. The 200 comes from `BETTER_AUTH_RESPONSES`.
 */
import { sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';

/** The options of a session-gated POST whose handler parses its own body. */
export function sessionPostOptions() {
  return {
    method: 'POST' as const,
    body: z.record(z.string(), z.unknown()),
    use: [sessionMiddleware],
  };
}

export function sessionGetOptions() {
  return { method: 'GET' as const, use: [sessionMiddleware] };
}
