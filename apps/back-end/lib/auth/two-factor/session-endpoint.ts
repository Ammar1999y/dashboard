/**
 * ⚠️ `body` feeds the published OpenAPI document: `lib/http/openapi/` renders
 * the library's generated request body for an endpoint whose entry declares
 * none. The 200 comes from the entry.
 */
import { sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';

/** The options of a session-gated endpoint whose handler parses its own body. */
export function sessionBodyOptions() {
  return {
    body: z.record(z.string(), z.unknown()),
    use: [sessionMiddleware],
  };
}

export function sessionOptions() {
  return { use: [sessionMiddleware] };
}
