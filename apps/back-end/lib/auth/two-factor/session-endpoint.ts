import { sessionMiddleware } from 'better-auth/api';
import * as z from 'zod';

import { envelopeResponse } from '../plugin-openapi';

/**
 * The options of a session-gated POST whose handler parses its own body.
 *
 * ⚠️ Feeds the published OpenAPI document: `body` and `metadata` are what
 * `lib/http/openapi/` renders for every endpoint built from this.
 */
export function sessionPostOptions(
  ...response: Parameters<typeof envelopeResponse>
) {
  return {
    method: 'POST' as const,
    body: z.record(z.string(), z.unknown()),
    use: [sessionMiddleware],
    metadata: { openapi: envelopeResponse(...response) },
  };
}
