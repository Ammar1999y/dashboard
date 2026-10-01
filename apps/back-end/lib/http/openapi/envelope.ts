import type { JsonSchema } from './json-schema';

import { componentRef, PAGINATION_META_SCHEMA } from './components';

export function successEnvelopeSchema(
  data: JsonSchema,
  paginated = false
): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { const: true },
      message: { type: 'string' },
      data,
      ...(paginated && { meta: PAGINATION_META_SCHEMA }),
    },
    required: ['success', 'message', 'data', ...(paginated ? ['meta'] : [])],
    additionalProperties: false,
  };
}

/** A response whose body is this API's error envelope. */
export function errorResponse(
  description: string,
  headers?: JsonSchema
): JsonSchema {
  return {
    description,
    ...(headers && { headers }),
    content: {
      'application/json': { schema: componentRef('ErrorEnvelope') },
    },
  };
}

export function bodyTooLargeResponse(maxBytes: number): JsonSchema {
  return errorResponse(
    `The request body exceeds ${maxBytes} bytes, which the server refuses before the route runs.`
  );
}

export const RETRY_AFTER_HEADER: JsonSchema = {
  description: 'Seconds until the caller should retry.',
  schema: { type: 'integer', minimum: 1 },
};

/**
 * The two responses the pre-auth admission limiter produces, for every
 * `preAuth: 'ip-limit'` route and every path under the Better Auth prefix.
 * Both call sites hand the failure to `handleApiError`, so the body is the
 * envelope even where the operation's own body is not.
 */
export const PRE_AUTH_RESPONSES: JsonSchema = {
  '429': errorResponse('Per-IP admission limit. See `Retry-After`.', {
    'Retry-After': RETRY_AFTER_HEADER,
    'X-RateLimit-Limit': {
      description: 'Request or cost budget for the active window.',
      schema: { type: 'integer', minimum: 1 },
    },
    'X-RateLimit-Remaining': {
      description: 'Budget remaining in the active window.',
      schema: { type: 'integer', minimum: 0 },
    },
  }),
  '503': errorResponse(
    'The admission limiter store is unavailable and fails closed.',
    { 'Retry-After': RETRY_AFTER_HEADER }
  ),
};
