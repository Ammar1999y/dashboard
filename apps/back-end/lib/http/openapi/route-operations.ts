/** The operations the route table serves, one per manifest entry. */
import type { RouteManifestEntry, RouteQueryParam } from '../route-manifest';
import type { JsonSchema } from './json-schema';

import { isSafeMethod } from '../origin';
import { bodyPolicyCeiling } from '../request';
import { CAPTCHA_HEADER_PARAMETER, UUID_SCHEMA } from './components';
import {
  bodyTooLargeResponse,
  errorResponse,
  PRE_AUTH_RESPONSES,
  RETRY_AFTER_HEADER,
  successEnvelopeSchema,
} from './envelope';
import { isJsonSchema, OPENAPI_VERSION } from './json-schema';
import {
  multipartRequestBody,
  requestBodies,
  requestBody,
} from './request-bodies';
import {
  BODY_SCHEMA_REFUSALS,
  BODYLESS_BAD_REQUEST_ROUTES,
  CHANNEL_UNAVAILABLE_ROUTES,
  CONFLICT_ROUTES,
  CONTACT_CHANGE_DESCRIPTIONS,
  CREATED_ROUTES,
  ID_NOT_FOUND_ROUTES,
  NOT_FOUND_ROUTES,
  OPERATION_DOCS,
  PAGINATED_SUCCESS_ROUTES,
  QUERY_VALIDATION_ROUTES,
  SESSION_COOKIE_ROUTES,
  SET_COOKIE_HEADER,
  SPENT_INPUT_REMEDIES,
} from './route-tables';
import { SUCCESS_DATA_SCHEMAS } from './success-schemas';

/** What a client does with a 401 `REAUTH_REQUIRED`, on either route family. */
export const REAUTH_REQUIRED_REMEDY =
  'open the re-authentication window at `POST /api/dash/auth/reauth`, then retry.';

export function operationKey(entry: RouteManifestEntry): string {
  return `${entry.method} ${entry.path}`;
}

export function operationSlug(path: string): string {
  return path.replaceAll(/[^a-zA-Z0-9]/g, '_');
}

/** `/api/dash/users/:id` → `/api/dash/users/{id}`, and the parameter list. */
export function toOpenApiPath(path: string): {
  path: string;
  parameters: JsonSchema[];
} {
  const parameters: JsonSchema[] = [];
  const converted = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const name = segment.slice(1);
      parameters.push({
        name,
        in: 'path',
        required: true,
        schema: name === 'id' ? UUID_SCHEMA : { type: 'string' },
      });
      return `{${name}}`;
    })
    .join('/');
  return { path: converted, parameters };
}

const STORAGE_CHECKS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    journalModeWal: { type: 'boolean' },
    schemaVersion: { type: 'boolean' },
    busyTimeout: { type: 'boolean' },
    synchronousNormal: { type: 'boolean' },
    postgres: { type: 'boolean' },
    quickCheck: { type: 'boolean' },
    writable: { type: 'boolean' },
  },
  required: [
    'journalModeWal',
    'schemaVersion',
    'busyTimeout',
    'synchronousNormal',
    'postgres',
  ],
  additionalProperties: false,
};

const STORAGE_RESPONSES: JsonSchema = {
  '200': {
    description: 'Every configured storage readiness check passed.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            status: { const: 'ok' },
            checks: STORAGE_CHECKS_SCHEMA,
          },
          required: ['status', 'checks'],
          additionalProperties: false,
        },
      },
    },
  },
  '401': {
    description:
      'The request carried no valid maintenance token. The whole route requires it, not only `deep=1`.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { status: { const: 'unauthorized' } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    },
  },
  '503': {
    description: 'A readiness check failed or the storage probe errored.',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                status: { const: 'degraded' },
                checks: STORAGE_CHECKS_SCHEMA,
              },
              required: ['status', 'checks'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { status: { const: 'error' } },
              required: ['status'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
  },
};

const OPENAPI_DOCUMENT_RESPONSE: JsonSchema = {
  description: 'The OpenAPI 3.1 contract for this deployment.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          openapi: { const: OPENAPI_VERSION },
          info: { type: 'object' },
          servers: { type: 'array' },
          tags: { type: 'array' },
          components: { type: 'object' },
          paths: { type: 'object' },
        },
        required: ['openapi', 'info', 'servers', 'tags', 'components', 'paths'],
        additionalProperties: true,
      },
    },
  },
};

function successResponseFor(key: string): JsonSchema {
  const data = SUCCESS_DATA_SCHEMAS[key];
  if (!data) throw new Error(`No success data schema for ${key}`);
  return {
    description: CONTACT_CHANGE_DESCRIPTIONS[key] ?? 'Success.',
    ...(SESSION_COOKIE_ROUTES.has(key) && { headers: SET_COOKIE_HEADER }),
    content: {
      'application/json': {
        schema: successEnvelopeSchema(data, PAGINATED_SUCCESS_ROUTES.has(key)),
      },
    },
  };
}

/**
 * Responses derived from route policy and the per-route status tables. 405 is
 * absent on purpose: a wrong method is a different request, answered by the
 * routing boundary rather than by this operation.
 */
function commonResponses(entry: RouteManifestEntry): JsonSchema {
  if (entry.response === 'storage-health') return { ...STORAGE_RESPONSES };

  const key = operationKey(entry);
  const success = CREATED_ROUTES.has(key) ? '201' : '200';
  const responses: JsonSchema = {
    '500': errorResponse(
      'An unexpected server or dependency failure occurred.'
    ),
    [success]:
      entry.response === 'openapi-document'
        ? OPENAPI_DOCUMENT_RESPONSE
        : successResponseFor(key),
  };

  // eslint-disable-next-line unicorn/no-immediate-mutation -- the map is assembled by the chain of conditions below, each with its own comment; one literal would bury them
  if (NOT_FOUND_ROUTES.has(key))
    responses['404'] = errorResponse(
      'The target does not exist, is outside the caller’s visible scope, or the feature is disabled.'
    );

  // `requireJsonBody` answers an absent or malformed body with 400 before the
  // schema runs.
  if (entry.body !== 'none' || BODYLESS_BAD_REQUEST_ROUTES.has(key))
    responses['400'] = errorResponse(
      entry.body === 'none'
        ? 'The operation violates a handler-level business rule.'
        : 'The request body is absent, empty, not parseable, or violates a handler-level business rule.'
    );

  // `bodyPolicyCeiling` is the function the boundary in `app.ts` refuses with,
  // so the published bound is the applied one.
  if (entry.body !== 'none')
    responses['413'] = bodyTooLargeResponse(
      bodyPolicyCeiling(entry.body, entry.maxJsonBodyBytes)
    );

  if (CONFLICT_ROUTES.has(key))
    responses['409'] = errorResponse(
      'A unique value or permission assignment already exists.'
    );

  const bodyRefusal = BODY_SCHEMA_REFUSALS[key];
  const pathIdIs422 = entry.path.includes(':') && !ID_NOT_FOUND_ROUTES.has(key);
  if (
    pathIdIs422 ||
    (!bodyRefusal && entry.body === 'json') ||
    QUERY_VALIDATION_ROUTES.has(key)
  )
    responses['422'] = errorResponse(
      pathIdIs422
        ? 'Validation failed — a schema field, or a path parameter, was rejected.'
        : 'Validation failed — a schema field was rejected.'
    );

  if (entry.auth !== 'public') {
    responses['401'] = errorResponse(
      entry.reauth
        ? `No session, or the session row is no longer live. With code \`REAUTH_REQUIRED\` the session is fine but the re-authentication window is closed: ${REAUTH_REQUIRED_REMEDY}`
        : 'No session, or the session row is no longer live.'
    );
  }

  // After the blocks above, one of which owns the status this replaces.
  if (bodyRefusal)
    responses[bodyRefusal.status] = errorResponse(bodyRefusal.description);

  // A captcha refusal reaches `public` routes no session guards, and the
  // `/api/dash/users/me/*` routes after their session check passes. The origin
  // refusal is the adapter's (`assertSameOriginWrite`), ahead of the handler.
  const forbidden = [
    entry.auth === 'permission'
      ? entry.captcha
        ? 'The caller lacks the required authority or failed the required captcha.'
        : 'The caller lacks the grant, scope or role authority this route requires.'
      : entry.captcha &&
        'The captcha this route requires was absent or rejected.',
    !isSafeMethod(entry.method) &&
      'A browser sent this write from an origin other than the application’s.',
  ].filter((reason) => typeof reason === 'string');
  if (forbidden.length > 0)
    responses['403'] = errorResponse(forbidden.join(' '));

  if (entry.preAuth === 'ip-limit' || entry.handlerRateLimit)
    Object.assign(responses, PRE_AUTH_RESPONSES);

  // After the limiter block, which owns the same status and would overwrite it.
  const limited = responses['429'];
  if (entry.checksPassword && isJsonSchema(limited))
    responses['429'] = {
      ...limited,
      description:
        'Per-IP admission limit, or the account is temporarily locked after failed password attempts. See `Retry-After`.',
    };

  // Every handler reaches the database, so every route can answer this 503.
  responses['503'] = errorResponse(
    [
      entry.preAuth === 'ip-limit' || entry.handlerRateLimit
        ? 'The admission limiter store is unavailable and fails closed.'
        : '',
      CHANNEL_UNAVAILABLE_ROUTES.has(key)
        ? 'No OTP channel able to verify this contact is enabled.'
        : '',
      'No database connection came free in time, or a transaction was aborted to break a deadlock.',
      SPENT_INPUT_REMEDIES[key] ?? '',
    ]
      .filter(Boolean)
      .join(' '),
    { 'Retry-After': RETRY_AFTER_HEADER }
  );

  return responses;
}

function queryParameter(param: RouteQueryParam): JsonSchema {
  const schema: JsonSchema = {
    type: param.type ?? 'string',
    ...(param.enum && { enum: [...param.enum] }),
    ...(param.minimum !== undefined && { minimum: param.minimum }),
    ...(param.maximum !== undefined && { maximum: param.maximum }),
    ...(param.minLength !== undefined && { minLength: param.minLength }),
    ...(param.maxLength !== undefined && { maxLength: param.maxLength }),
    ...(param.pattern !== undefined && { pattern: param.pattern }),
  };
  return {
    name: param.name,
    in: 'query',
    required: param.required,
    description: param.description,
    schema,
    ...(param.example !== undefined && { example: param.example }),
  };
}

export function tableOperation(entry: RouteManifestEntry): {
  path: string;
  operation: JsonSchema;
} {
  const { path, parameters } = toOpenApiPath(entry.path);
  const queryParams = entry.query ?? [];
  for (const param of queryParams) parameters.push(queryParameter(param));
  if (entry.captcha) parameters.push(CAPTCHA_HEADER_PARAMETER);
  if (entry.response === 'storage-health')
    parameters.push({
      name: 'x-maintenance-token',
      in: 'header',
      required: true,
      description:
        'The shared maintenance secret. Required on every request to this route; without it the answer is 401.',
      schema: { type: 'string', minLength: 1 },
    });

  const key = operationKey(entry);
  const docs = OPERATION_DOCS[key];
  if (!docs) throw new Error(`No operation documentation for ${key}`);
  const operation: JsonSchema = {
    operationId: `${entry.method.toLowerCase()}${operationSlug(entry.path)}`,
    summary: docs.summary,
    ...(docs.description && { description: docs.description }),
    tags: [docs.tag],
    responses: commonResponses(entry),
    security: entry.auth === 'public' ? [] : [{ sessionCookie: [] }],
    ...(parameters.length > 0 && { parameters }),
  };

  const schemas = requestBodies[key];
  if (schemas) {
    const body = requestBody(schemas, key);
    if (body) operation.requestBody = body;
  } else if (entry.body === 'multipart')
    operation.requestBody = multipartRequestBody(key);

  return { path, operation };
}
