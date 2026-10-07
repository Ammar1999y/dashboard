/**
 * The operations served under the Better Auth prefix: the library's own
 * generated document, merged with the corrections this deployment needs.
 */
import type { HttpMethod, RoutePrefixPath } from '../route-manifest';
import type { JsonSchema } from './json-schema';
import type * as z from 'zod';

import { roleScope } from '@/db/schema';

import { BETTER_AUTH_BODIES } from '@app/shared/contract';
import { isBetterAuthResponseRoute } from '@app/shared/response-contract';
import { UUID_V7_PATTERN } from '@app/shared/utils';
import { OAUTH_STATE_LOST_PAGE } from '@app/shared/validation/oauth';
import { passkeyGrantSchema } from '@app/shared/validation/two-factor';

import { auth } from '@/lib/auth';
import { BETTER_AUTH_ROUTE_PREFIX } from '@/lib/auth/allowed-paths';
import { TWO_FACTOR_COOKIE_NAME } from '@/lib/auth/two-factor/challenge';
import { TOTP_ENROLMENT_MAX_AGE_S } from '@/lib/auth/two-factor/enrolment';

import { bodyPolicyCeiling } from '../request';
import {
  BETTER_AUTH_DATABASE_FAULT_PATHS,
  BETTER_AUTH_LOCAL_THROTTLE_PATHS,
  BETTER_AUTH_PASSWORD_LOCKOUT_PATHS,
  BETTER_AUTH_PATH_STATUSES,
  BETTER_AUTH_RESPONSE_DESCRIPTIONS,
  BETTER_AUTH_SPENT_INPUT_REMEDIES,
  BETTER_AUTH_STATUS_DESCRIPTIONS,
  BETTER_AUTH_SUMMARIES,
  CHALLENGE_INSTEAD,
  TWO_FACTOR_CHALLENGE_PATHS,
} from './better-auth-tables';
import {
  CAPTCHA_HEADER_PARAMETER,
  componentRef,
  NULLABLE_STRING_SCHEMA,
  USER_PERMISSION_MATRIX_SCHEMA,
  UUID_SCHEMA,
} from './components';
import { bodyTooLargeResponse, PRE_AUTH_RESPONSES } from './envelope';
import { isJsonSchema, normalizeOpenApi31, toJsonSchema } from './json-schema';
import { requestBody } from './request-bodies';
import { operationSlug, REAUTH_REQUIRED_REMEDY } from './route-operations';
import { betterAuthSuccessSchema } from './success-schemas';

const BETTER_AUTH_OPENAPI = await auth.api.generateOpenAPISchema();
const BETTER_AUTH_CONTEXT = await auth.$context;

/** The cookie as the library names it — prefix, and `__Secure-` where it applies. */
const TWO_FACTOR_CHALLENGE_COOKIE_NAME = BETTER_AUTH_CONTEXT.createAuthCookie(
  TWO_FACTOR_COOKIE_NAME
).name;

/**
 * What each declared credential publishes. A list with several entries is an
 * either/or, which is how `optional` publishes "with or without a cookie".
 *
 * The challenge cookie has a scheme of its own: the operations that complete a
 * sign-in answer 401 without it, and `sessionCookie` would name a cookie they
 * do not read.
 */
const SECURITY_FOR_SESSION: Record<
  RoutePrefixPath['session'],
  readonly JsonSchema[]
> = {
  session: [{ sessionCookie: [] }],
  optional: [{}, { sessionCookie: [] }],
  challenge: [{ twoFactorChallengeCookie: [] }],
  'session-or-challenge': [
    { sessionCookie: [] },
    { twoFactorChallengeCookie: [] },
  ],
  none: [],
};

/** `BETTER_AUTH_BODIES` with its keys widened to `string` for lookup by path. */
const betterAuthBodies: Readonly<Record<string, z.ZodType>> =
  BETTER_AUTH_BODIES;

/**
 * A reference to a schema Better Auth's document defines, which
 * `referencedBetterAuthSchemas` merges in.
 *
 * Checked at load because the name belongs to the library and no type can see
 * a rename in an upgrade. `routes.ts` imports this module, so the refusal is a
 * boot refusal.
 */
function libraryComponentRef(name: string): JsonSchema {
  const schemas = BETTER_AUTH_OPENAPI.components.schemas;
  if (!isJsonSchema(schemas) || !(name in schemas))
    throw new Error(
      `Better Auth's generated document no longer defines components.schemas '${name}'; ` +
        'every $ref this file emits for it would resolve to nothing.'
    );
  return { $ref: `#/components/schemas/${name}` };
}

export function generatedBetterAuthOperation(
  path: string,
  method: HttpMethod
): JsonSchema | null {
  const pathItem = BETTER_AUTH_OPENAPI.paths[path];
  if (!isJsonSchema(pathItem)) return null;
  const operation = pathItem[method.toLowerCase()];
  return isJsonSchema(operation) ? operation : null;
}

export function generatedBetterAuthResponse(
  path: string,
  method: HttpMethod,
  status: string
): JsonSchema | null {
  const operation = generatedBetterAuthOperation(path, method);
  if (!operation || !isJsonSchema(operation.responses)) return null;
  const response = operation.responses[status];
  if (!isJsonSchema(response)) return null;
  const normalized = normalizeOpenApi31(response);
  return isJsonSchema(normalized) ? normalized : null;
}

/** What one path adds to a shared status description, keyed by path, then status. */
const BETTER_AUTH_STATUS_DETAILS: Record<
  string,
  Partial<Record<keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS, string>>
> = {
  '/two-factor/totp/confirm': {
    '400': `So is a confirmation more than ${TOTP_ENROLMENT_MAX_AGE_S / 60} minutes after \`/two-factor/totp/start\`: the enrolment has expired, and the client starts it again.`,
  },
};

/** The 401 every path in `BETTER_AUTH_PASSWORD_LOCKOUT_PATHS` can also answer. */
const REAUTH_REQUIRED_DETAIL = `With code \`REAUTH_REQUIRED\` no \`password\` was sent and the re-authentication window is closed: send \`password\`, or ${REAUTH_REQUIRED_REMEDY}`;

function isDescribedStatus(
  status: string
): status is keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS {
  return status in BETTER_AUTH_STATUS_DESCRIPTIONS;
}

/** What an `APIError` serialises to. `code` is not required — the shape is the dependency's. */
const BETTER_AUTH_ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { message: { type: 'string' }, code: { type: 'string' } },
  required: ['message'],
};

function withDescription(response: unknown, detail: string): JsonSchema {
  if (!isJsonSchema(response)) return { description: detail };
  return {
    ...response,
    description: `${String(response.description ?? '')} ${detail}`.trim(),
  };
}

/**
 * Widens one response to admit a second JSON body alongside the one it
 * declares; `fallback` stands in for a response that is not there.
 *
 * `anyOf`, never `oneOf`: an alternative may overlap the declared body — the
 * envelope satisfies Better Call's error shape — and exactly-one would then
 * fail on the body the limiter actually sends.
 */
function withAlternativeJsonBody(
  response: unknown,
  extra: JsonSchema,
  detail: string,
  fallback: JsonSchema
): JsonSchema {
  if (!isJsonSchema(response)) return fallback;
  const content = isJsonSchema(response.content) ? response.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  return {
    ...response,
    description: `${String(response.description ?? '')} ${detail}`.trim(),
    content: {
      ...content,
      'application/json': {
        ...json,
        schema: { anyOf: [json.schema, extra] },
      },
    },
  };
}

const VERIFIER_SESSION_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'The second factor was accepted and a session cookie is set. `token` is that session’s token; the cookie is what subsequent requests use.',
  properties: {
    token: { type: 'string' },
    user: libraryComponentRef('User'),
  },
  required: ['token', 'user'],
};

/**
 * The 200 of the two verifiers that pass the library's body through, where the
 * library's generated document is wrong about it. Both answer through the
 * shared `valid()` in `better-auth/plugins/two-factor/verify-two-factor.mjs`,
 * which returns `{ token, user }`, not the shapes the plugin's metadata
 * declares. Every other served path takes its 200 from the shared
 * `BETTER_AUTH_RESPONSES` or is attested in `BETTER_AUTH_TRUSTED_RESPONSES`;
 * `consistency.ts` refuses a path in none of the three, or in two.
 */
const LIBRARY_VERIFIER_RESPONSES: Record<string, JsonSchema> = {
  '/two-factor/verify-totp': {
    description:
      'The authenticator code was accepted and the sign-in is complete.',
    content: { 'application/json': { schema: VERIFIER_SESSION_SCHEMA } },
  },
  '/two-factor/verify-backup-code': {
    description:
      'The backup code was accepted, consumed, and the sign-in is complete.',
    content: { 'application/json': { schema: VERIFIER_SESSION_SCHEMA } },
  },
};

export const LIBRARY_VERIFIER_PATHS: ReadonlySet<string> = new Set(
  Object.keys(LIBRARY_VERIFIER_RESPONSES)
);

/** A path's 200 when this project, not the library's generated document, decides it. */
function decidedSuccessResponse(path: string): JsonSchema | undefined {
  if (isBetterAuthResponseRoute(path))
    return {
      description: BETTER_AUTH_RESPONSE_DESCRIPTIONS[path],
      content: {
        'application/json': { schema: betterAuthSuccessSchema(path) },
      },
    };
  return LIBRARY_VERIFIER_RESPONSES[path];
}

function betterAuthResponses(path: string, method: HttpMethod): JsonSchema {
  const statuses = [
    '200',
    '404',
    '500',
    ...(BETTER_AUTH_PATH_STATUSES[path] ?? []),
  ];
  const responses: JsonSchema = { ...PRE_AUTH_RESPONSES };

  const localThrottle = BETTER_AUTH_LOCAL_THROTTLE_PATHS.has(path);
  const passwordLockout = BETTER_AUTH_PASSWORD_LOCKOUT_PATHS.has(path);
  const databaseFault = BETTER_AUTH_DATABASE_FAULT_PATHS.has(path);
  if (localThrottle || passwordLockout)
    responses['429'] = withAlternativeJsonBody(
      responses['429'],
      BETTER_AUTH_ERROR_SCHEMA,
      [
        localThrottle &&
          'The endpoint’s own per-destination verify quota answers here too, in Better Auth’s error shape.',
        passwordLockout &&
          'So does an account temporarily locked after failed password attempts, in Better Auth’s error shape; `Retry-After` is the time left.',
      ]
        .filter(Boolean)
        .join(' '),
      BETTER_AUTH_ERROR_SCHEMA
    );
  const database = `No database connection came free in time, or a transaction was aborted to break a deadlock; ${
    BETTER_AUTH_SPENT_INPUT_REMEDIES[path] ?? 'retry after `Retry-After`.'
  }`;
  // Endpoints that map a failure themselves (`asAuthError`) answer in Better
  // Auth's shape; every other path's database 503 reaches the envelope.
  responses['503'] =
    localThrottle || passwordLockout || databaseFault
      ? withAlternativeJsonBody(
          responses['503'],
          BETTER_AUTH_ERROR_SCHEMA,
          [
            localThrottle &&
              'That quota is fail-closed, so a degraded limiter store refuses here in Better Auth’s error shape.',
            database,
            'Either may come in the envelope or in Better Auth’s error shape.',
          ]
            .filter(Boolean)
            .join(' '),
          BETTER_AUTH_ERROR_SCHEMA
        )
      : withDescription(responses['503'], database);

  for (const status of statuses) {
    const generated =
      (status === '200' ? decidedSuccessResponse(path) : undefined) ??
      generatedBetterAuthResponse(
        path,
        method,
        status === '422' ? '400' : status
      );
    responses[status] = {
      ...generated,
      ...(isDescribedStatus(status) && {
        description: [
          BETTER_AUTH_STATUS_DESCRIPTIONS[status],
          BETTER_AUTH_STATUS_DETAILS[path]?.[status],
          status === '401' && passwordLockout && REAUTH_REQUIRED_DETAIL,
        ]
          .filter(Boolean)
          .join(' '),
      }),
    };
  }

  // The boundary in `app.ts` refuses these before the library reads the body,
  // so the answer is this project's envelope.
  if (method === 'POST')
    responses['413'] = bodyTooLargeResponse(
      bodyPolicyCeiling(BETTER_AUTH_ROUTE_PREFIX.body)
    );

  // The library's own body is the other branch, so the challenge is appended
  // rather than published with it as one union. The two share no required key:
  // a client tells them apart on `twoFactorRedirect` alone.
  if (method === 'POST' && TWO_FACTOR_CHALLENGE_PATHS.has(path)) {
    const challenge = componentRef('TwoFactorChallenge');
    responses['200'] = withAlternativeJsonBody(
      responses['200'],
      challenge,
      CHALLENGE_INSTEAD,
      { content: { 'application/json': { schema: challenge } } }
    );
  }

  if (path === '/oauth/google/callback')
    responses['302'] = {
      description: `Return to the validated same-origin callbackURL, without codes or tokens. Fetch /api/auth/oauth/result with cookies to consume the result. A callback whose sign-in state is gone (expired, already used, started in another browser, or never issued here) cannot know that callbackURL and goes to ${OAUTH_STATE_LOST_PAGE} instead, whatever mode the flow started in; start a new sign-in from there. A database or server fault answers 500 or 503 instead, with or without a callbackURL.`,
      headers: { Location: { schema: { type: 'string', format: 'uri' } } },
    };

  return responses;
}

/** The document path of a Better Auth endpoint. */
export function betterAuthDocumentPath(path: string): string {
  return `${BETTER_AUTH_ROUTE_PREFIX.prefix}${path}`;
}

/**
 * The grant's constraints are `passkeyGrantSchema`'s. Each transport describes
 * itself, so the schema's own description is dropped.
 */
function passkeyGrantConstraints(): JsonSchema {
  const converted = toJsonSchema(passkeyGrantSchema);
  if (!converted)
    throw new Error('passkeyGrantSchema has no JSON Schema representation.');
  const { description: _described, ...constraints } = converted;
  return constraints;
}

/**
 * The library's registration body plus the `grant` `path-policy.ts` spends,
 * which the library's own schema does not know about.
 */
function withGrantField(requestBody: JsonSchema): JsonSchema {
  const content = isJsonSchema(requestBody.content) ? requestBody.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  const schema = isJsonSchema(json.schema) ? json.schema : {};
  const properties = isJsonSchema(schema.properties) ? schema.properties : {};
  return {
    ...requestBody,
    content: {
      ...content,
      'application/json': {
        ...json,
        schema: {
          ...schema,
          properties: {
            ...properties,
            grant: {
              ...passkeyGrantConstraints(),
              description:
                'The token POST /two-factor/passkey/grant answered with. Required here or as the `grant` query parameter.',
            },
          },
        },
      },
    },
  };
}

/** Only the methods the path declares, each a fresh operation with its own id. */
export function betterAuthPathItem(endpoint: RoutePrefixPath): JsonSchema {
  const schema = betterAuthBodies[endpoint.path];
  const slug = operationSlug(endpoint.path);

  const build = (method: HttpMethod): JsonSchema => {
    const generated = generatedBetterAuthOperation(endpoint.path, method);
    const summary =
      BETTER_AUTH_SUMMARIES[`${method} ${endpoint.path}`] ??
      `Better Auth ${method} ${endpoint.path}`;
    const operation: JsonSchema = {
      operationId: `betterAuth_${method.toLowerCase()}${slug}`,
      summary,
      tags: ['Authentication'],
      description:
        'Served by the authentication library, which owns its own routing, ' +
        'validation and response shapes under this prefix. Every path under ' +
        'it that is not documented here is answered 404.',
      responses: betterAuthResponses(endpoint.path, method),
      security: SECURITY_FOR_SESSION[endpoint.session],
    };
    const parameters: JsonSchema[] =
      endpoint.path === '/oauth/google/callback' &&
      Array.isArray(generated?.parameters)
        ? generated.parameters.filter(isJsonSchema)
        : [];
    if (method === 'GET' && endpoint.path === '/get-session')
      parameters.push(
        {
          name: 'disableCookieCache',
          in: 'query',
          required: false,
          description:
            'Read the database-backed session instead of the signed cookie cache.',
          schema: { type: 'boolean' },
        },
        {
          name: 'disableRefresh',
          in: 'query',
          required: false,
          description: 'Do not refresh session expiry during this read.',
          schema: { type: 'boolean' },
        }
      );
    if (method === 'POST' && endpoint.path === '/passkey/verify-registration')
      parameters.push({
        name: 'grant',
        in: 'query',
        required: false,
        description:
          'The same grant as the body field, for the stock client, whose `addPasskey` writes this body itself. The body wins when both are sent.',
        schema: passkeyGrantConstraints(),
      });
    if (endpoint.captcha) parameters.push(CAPTCHA_HEADER_PARAMETER);
    if (parameters.length > 0) operation.parameters = parameters;
    // A request body is published on POST only; on GET it describes a request
    // no client can make.
    if (schema && method === 'POST') {
      const body = requestBody(schema, `${method} ${endpoint.path}`);
      if (body) operation.requestBody = body;
    } else if (method === 'POST' && isJsonSchema(generated?.requestBody)) {
      const normalized = normalizeOpenApi31(generated.requestBody);
      if (isJsonSchema(normalized))
        operation.requestBody =
          endpoint.path === '/passkey/verify-registration'
            ? withGrantField(normalized)
            : normalized;
    }
    return operation;
  };

  return Object.fromEntries(
    endpoint.methods.map((method): [string, JsonSchema] => [
      method.toLowerCase(),
      build(method),
    ])
  );
}

const NULLABLE_UUID_V7_SCHEMA: JsonSchema = {
  type: ['string', 'null'],
  pattern: UUID_V7_PATTERN,
};

/**
 * The Better Auth component schemas the document's paths reference,
 * transitively, with the fields this deployment narrows.
 */
export function referencedBetterAuthSchemas(paths: JsonSchema): JsonSchema {
  const normalized = normalizeOpenApi31(BETTER_AUTH_OPENAPI.components.schemas);
  if (!isJsonSchema(normalized)) return {};

  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isJsonSchema(value)) return;
    const ref = value.$ref;
    if (typeof ref === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
      if (match?.[1] && !referenced.has(match[1])) {
        referenced.add(match[1]);
        visit(normalized[match[1]]);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(paths);

  const selected: JsonSchema = Object.fromEntries(
    [...referenced]
      .filter((name) => isJsonSchema(normalized[name]))
      .map((name) => [name, normalized[name]])
  );

  const user = selected.User;
  if (isJsonSchema(user) && isJsonSchema(user.properties)) {
    selected.User = {
      ...user,
      properties: {
        ...user.properties,
        id: UUID_SCHEMA,
        email: { type: 'string', format: 'email' },
        image: NULLABLE_STRING_SCHEMA,
        roleId: NULLABLE_UUID_V7_SCHEMA,
      },
    };
  }

  const session = selected.Session;
  if (isJsonSchema(session) && isJsonSchema(session.properties)) {
    selected.Session = {
      ...session,
      properties: {
        ...session.properties,
        id: UUID_SCHEMA,
        userId: UUID_SCHEMA,
        ipAddress: NULLABLE_STRING_SCHEMA,
        userAgent: NULLABLE_STRING_SCHEMA,
        metadata: {
          type: 'object',
          properties: {
            roleId: NULLABLE_UUID_V7_SCHEMA,
            roleName: NULLABLE_STRING_SCHEMA,
            roleScope: {
              type: ['string', 'null'],
              enum: [...roleScope.enumValues, null],
            },
            permissions: USER_PERMISSION_MATRIX_SCHEMA,
          },
          additionalProperties: false,
          default: {},
          readOnly: true,
        },
      },
    };
  }

  return selected;
}

export function securitySchemes(): JsonSchema {
  return {
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: BETTER_AUTH_CONTEXT.authCookies.sessionToken.name,
    },
    twoFactorChallengeCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: TWO_FACTOR_CHALLENGE_COOKIE_NAME,
      description:
        'Issued by a first factor that needs a second one, and required by every operation that completes the challenge.',
    },
  };
}
