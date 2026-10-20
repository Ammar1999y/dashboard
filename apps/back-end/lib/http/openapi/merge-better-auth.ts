/**
 * The Better Auth operations for the generated document: the library's own
 * document filtered to the allowlist, with this project's request and response
 * schemas and the corrections in `better-auth-tables.ts` applied. Built on
 * first generation, so the library's document stays off the boot path.
 */
import type { HttpMethod, RoutePrefixPath } from '../routing';
import type { MergedPaths } from './finalize';
import type { JsonSchema } from './json-schema';
import type { Table } from 'drizzle-orm';

import { getTableColumns } from 'drizzle-orm';

import { passkeys, roleScope, sessions, users } from '@/db/schema';
import * as z from 'zod';

import { isPluginPath, PLUGIN_ENDPOINTS } from '@app/shared/api/all';
import { authProblemSchema } from '@app/shared/api/wire';
import {
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTION_NAMES,
} from '@app/shared/permissions/constants';
import { twoFactorChallengeSchema } from '@app/shared/responses/better-auth';
import { UUID_V7_PATTERN } from '@app/shared/utils';
import { OAUTH_STATE_LOST_PAGE } from '@app/shared/validation/oauth';
import { passkeyGrantSchema } from '@app/shared/validation/two-factor';

import { auth } from '@/lib/auth';
import {
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_ROUTE_PREFIX,
} from '@/lib/auth/allowed-paths';
import { TWO_FACTOR_COOKIE_NAME } from '@/lib/auth/two-factor/challenge';
import { TOTP_ENROLMENT_MAX_AGE_S } from '@/lib/auth/two-factor/enrolment';

import {
  DATABASE_UNAVAILABLE,
  DECLARED_LENGTH_REFUSAL,
  REAUTH_REQUIRED_REMEDY,
} from '../refusals';
import { bodyPolicyCeiling } from '../request';
import {
  BETTER_AUTH_CREDENTIAL_LOCKOUT_PATHS,
  BETTER_AUTH_LOCAL_THROTTLE_PATHS,
  BETTER_AUTH_PASSWORD_LOCKOUT_PATHS,
  BETTER_AUTH_PATH_STATUSES,
  BETTER_AUTH_RESPONSE_DESCRIPTIONS,
  BETTER_AUTH_SPENT_INPUT_REMEDIES,
  BETTER_AUTH_STATUS_DESCRIPTIONS,
  BETTER_AUTH_SUMMARIES,
  CHALLENGE_INSTEAD,
  LIBRARY_REQUEST_BODIES,
  LIBRARY_SUCCESS_PROPERTIES,
  LIBRARY_VERIFIER_DESCRIPTIONS,
  REDIRECTING_PLUGIN_PATHS,
  TWO_FACTOR_CHALLENGE_PATHS,
} from './better-auth-tables';
import {
  CAPTCHA_HEADER_PARAMETER,
  operationIdOf,
  problemContent,
  publishedSchema,
  requestBody,
  RESPONSE_HEADERS,
} from './finalize';
import { isJsonSchema, normalizeOpenApi31 } from './json-schema';

/** Every refusal under the prefix, the library's and the route's own alike. */
const errorResponse = (
  description: string,
  headers?: JsonSchema
): JsonSchema => ({
  description,
  ...(headers && { headers }),
  content: problemContent(authProblemSchema),
});

/** The wildcard's own admission limiter answers these on every path. */
const PRE_AUTH_RESPONSES: JsonSchema = {
  '429': errorResponse('Per-IP admission limit. See `Retry-After`.', {
    'Retry-After': RESPONSE_HEADERS['Retry-After'],
    'X-RateLimit-Limit': RESPONSE_HEADERS['X-RateLimit-Limit'],
    'X-RateLimit-Remaining': RESPONSE_HEADERS['X-RateLimit-Remaining'],
  }),
  '503': errorResponse(
    'The admission limiter store is unavailable and fails closed.',
    { 'Retry-After': RESPONSE_HEADERS['Retry-After'] }
  ),
};

/**
 * What each declared credential publishes. Several entries are an either/or,
 * which is how `optional` says "with or without a cookie".
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

const STATUS_DETAILS: Record<string, Partial<Record<string, string>>> = {
  '/two-factor/totp/confirm': {
    '400': `So is a confirmation more than ${TOTP_ENROLMENT_MAX_AGE_S / 60} minutes after \`/two-factor/totp/start\`: the enrolment has expired, and the client starts it again.`,
  },
};

const REAUTH_REQUIRED_DETAIL = `With code \`REAUTH_REQUIRED\` no \`password\` was sent and the re-authentication window is closed: send \`password\`, or ${REAUTH_REQUIRED_REMEDY}`;

const libraryBodies: Readonly<Record<string, z.ZodType>> =
  LIBRARY_REQUEST_BODIES;

/** The body a client sends to `path`, where this project publishes one. */
const publishedBodyOf = (path: string): z.ZodType | undefined =>
  PLUGIN_ENDPOINTS.get(path)?.body ?? libraryBodies[path];

const sentence = (...parts: unknown[]) =>
  parts.filter((part) => typeof part === 'string' && part !== '').join(' ');

/** One more reason the same refusal is answered. */
const withReason = (response: unknown, detail: string): JsonSchema => ({
  ...(isJsonSchema(response) && response),
  description: sentence(
    isJsonSchema(response) ? response.description : undefined,
    detail
  ),
});

/** A second JSON body beside the declared one. */
function withAlternative(
  response: unknown,
  extra: JsonSchema,
  detail: string
): JsonSchema {
  if (!isJsonSchema(response))
    return { content: { 'application/json': { schema: extra } } };
  const content = isJsonSchema(response.content) ? response.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  return {
    ...response,
    description: sentence(response.description, detail),
    content: {
      ...content,
      'application/json': { ...json, schema: { anyOf: [json.schema, extra] } },
    },
  };
}

/** The library's document, corrected for a 3.1 document, and its cookies. */
async function libraryDocument() {
  const [generated, context] = await Promise.all([
    auth.api.generateOpenAPISchema(),
    auth.$context,
  ]);
  const normalized = normalizeOpenApi31(generated);
  if (!isJsonSchema(normalized) || !isJsonSchema(normalized.paths))
    throw new Error('Better Auth generated no OpenAPI paths.');
  const components = isJsonSchema(normalized.components)
    ? normalized.components
    : {};
  return {
    paths: normalized.paths,
    schemas: isJsonSchema(components.schemas) ? components.schemas : {},
    sessionCookie: context.authCookies.sessionToken.name,
    challengeCookie: context.createAuthCookie(TWO_FACTOR_COOKIE_NAME).name,
  };
}

type Library = Awaited<ReturnType<typeof libraryDocument>>;

function libraryOperation(
  library: Library,
  path: string,
  method: HttpMethod
): JsonSchema | undefined {
  const item = library.paths[path];
  const operation = isJsonSchema(item) ? item[method.toLowerCase()] : undefined;
  return isJsonSchema(operation) ? operation : undefined;
}

/** A name the library defines, checked because no type sees a rename in an upgrade. */
function libraryRef(library: Library, name: string): JsonSchema {
  if (!isJsonSchema(library.schemas[name]))
    throw new Error(
      `Better Auth's document no longer defines components.schemas '${name}'.`
    );
  return { $ref: `#/components/schemas/${name}` };
}

function verifierResponse(library: Library, description: string): JsonSchema {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          description:
            'The second factor was accepted and a session cookie is set. `token` is that session’s token; the cookie is what subsequent requests use.',
          properties: {
            token: { type: 'string' },
            user: libraryRef(library, 'User'),
          },
          required: ['token', 'user'],
        },
      },
    },
  };
}

function successResponse(
  library: Library,
  path: string
): JsonSchema | undefined {
  const entry = PLUGIN_ENDPOINTS.get(path);
  if (entry && isPluginPath(path))
    return {
      description: BETTER_AUTH_RESPONSE_DESCRIPTIONS[path],
      content: {
        'application/json': {
          schema: publishedSchema(entry.response.raw),
        },
      },
    };
  const verifier = LIBRARY_VERIFIER_DESCRIPTIONS[path];
  return verifier === undefined
    ? undefined
    : verifierResponse(library, verifier);
}

/**
 * The library's own 200, with the properties its generator declares wrongly
 * replaced (`LIBRARY_SUCCESS_PROPERTIES`).
 */
function librarySuccess(
  library: Library,
  path: string,
  method: HttpMethod
): JsonSchema {
  const generated = libraryOperation(library, path, method)?.responses;
  const generatedAnswer = isJsonSchema(generated)
    ? generated['200']
    : undefined;
  if (!isJsonSchema(generatedAnswer))
    throw new Error(
      `Better Auth's document no longer answers ${method} ${path} 200.`
    );
  const answer = storedRequired(library, generatedAnswer);
  const corrections = LIBRARY_SUCCESS_PROPERTIES[path];
  if (!corrections) return answer;
  const content = isJsonSchema(answer.content) ? answer.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  const schema = isJsonSchema(json.schema) ? json.schema : {};
  const properties = isJsonSchema(schema.properties) ? schema.properties : {};
  for (const name of Object.keys(corrections))
    if (!Object.hasOwn(properties, name))
      throw new Error(
        `Better Auth's ${method} ${path} 200 no longer declares '${name}'.`
      );
  return {
    ...answer,
    content: {
      ...content,
      'application/json': {
        ...json,
        schema: { ...schema, properties: { ...properties, ...corrections } },
      },
    },
  };
}

const REDIRECTING: ReadonlySet<string> = new Set(REDIRECTING_PLUGIN_PATHS);

function responsesOf(
  library: Library,
  path: string,
  method: HttpMethod
): JsonSchema {
  const responses: JsonSchema = { ...PRE_AUTH_RESPONSES };
  const throttled = BETTER_AUTH_LOCAL_THROTTLE_PATHS.has(path);
  const lockout = BETTER_AUTH_PASSWORD_LOCKOUT_PATHS.has(path);
  const credentialLockout = BETTER_AUTH_CREDENTIAL_LOCKOUT_PATHS.has(path);

  if (throttled || lockout || credentialLockout)
    responses['429'] = withReason(
      responses['429'],
      sentence(
        throttled &&
          'The endpoint’s own per-destination verify quota answers here too.',
        lockout &&
          'So does an account temporarily locked after failed password attempts; `Retry-After` is the time left.',
        credentialLockout &&
          'So does a second-factor credential temporarily locked after repeated failed verifications.'
      )
    );
  const database = `${DATABASE_UNAVAILABLE}; ${
    BETTER_AUTH_SPENT_INPUT_REMEDIES[path] ?? 'retry after `Retry-After`.'
  }`;
  responses['503'] = errorResponse(
    sentence(
      'The admission limiter store is unavailable and fails closed.',
      throttled && 'The endpoint’s own verify quota fails closed too.',
      database
    ),
    { 'Retry-After': RESPONSE_HEADERS['Retry-After'] }
  );

  responses['200'] =
    successResponse(library, path) ?? librarySuccess(library, path, method);
  for (const status of [
    ...(method === 'POST' ? (['400'] as const) : []),
    '404',
    '500',
    ...(BETTER_AUTH_PATH_STATUSES[path] ?? []),
  ] as const)
    responses[status] = errorResponse(
      sentence(
        BETTER_AUTH_STATUS_DESCRIPTIONS[status],
        STATUS_DETAILS[path]?.[status],
        status === '401' && lockout && REAUTH_REQUIRED_DETAIL
      )
    );

  // The request hook refuses these before the library is called.
  responses['413'] = errorResponse(
    method === 'POST'
      ? `The request body exceeds ${bodyPolicyCeiling(BETTER_AUTH_ROUTE_PREFIX.body)} bytes, which the server refuses before the route runs.`
      : DECLARED_LENGTH_REFUSAL
  );

  // Appended rather than published as one union with the library's body: the
  // two share no required key, so `twoFactorRedirect` alone tells them apart.
  if (method === 'POST' && TWO_FACTOR_CHALLENGE_PATHS.has(path))
    responses['200'] = withAlternative(
      responses['200'],
      publishedSchema(twoFactorChallengeSchema),
      CHALLENGE_INSTEAD
    );

  if (REDIRECTING.has(path))
    responses['302'] = {
      description: `Return to the validated same-origin callbackURL, without codes or tokens. Fetch /api/auth/oauth/result with cookies to consume the result. A callback whose sign-in state is gone (expired, already used, started in another browser, or never issued here) cannot know that callbackURL and goes to ${OAUTH_STATE_LOST_PAGE} instead, whatever mode the flow started in; start a new sign-in from there. A database or server fault answers 500 or 503 instead, with or without a callbackURL.`,
      headers: { Location: { schema: { type: 'string', format: 'uri' } } },
    };

  return responses;
}

/** `passkeyGrantSchema`'s constraints; each place that takes it describes itself. */
function grantConstraints(): JsonSchema {
  const { description: _own, ...constraints } = publishedSchema(
    passkeyGrantSchema,
    'input'
  );
  return constraints;
}

function parametersOf(
  library: Library,
  endpoint: RoutePrefixPath,
  method: HttpMethod
): JsonSchema[] {
  const generated = libraryOperation(library, endpoint.path, method);
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
      schema: grantConstraints(),
    });
  if (endpoint.captcha) parameters.push(CAPTCHA_HEADER_PARAMETER);
  return parameters;
}

/**
 * A body is published on POST only. A path with no schema of ours keeps the
 * library's; registration also takes the `grant` `path-policy.ts` spends.
 */
function requestBodyOf(library: Library, path: string): JsonSchema | undefined {
  const schema = publishedBodyOf(path);
  if (schema) return requestBody(schema, 'json');
  const body = libraryOperation(library, path, 'POST')?.requestBody;
  if (path !== '/passkey/verify-registration' || !isJsonSchema(body))
    return isJsonSchema(body) ? body : undefined;
  const content = isJsonSchema(body.content) ? body.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  const root = isJsonSchema(json.schema) ? json.schema : {};
  const properties = isJsonSchema(root.properties) ? root.properties : {};
  const grant = {
    ...grantConstraints(),
    description:
      'The token POST /two-factor/passkey/grant answered with. Required here or as the `grant` query parameter.',
  };
  return {
    ...body,
    content: {
      ...content,
      'application/json': {
        ...json,
        schema: { ...root, properties: { ...properties, grant } },
      },
    },
  };
}

function pathItem(library: Library, endpoint: RoutePrefixPath): JsonSchema {
  const operation = (method: HttpMethod): JsonSchema => {
    const parameters = parametersOf(library, endpoint, method);
    const body =
      method === 'POST' ? requestBodyOf(library, endpoint.path) : undefined;
    return {
      operationId: `betterAuth_${operationIdOf(method, endpoint.path)}`,
      summary:
        BETTER_AUTH_SUMMARIES[`${method} ${endpoint.path}`] ??
        `Better Auth ${method} ${endpoint.path}`,
      tags: ['Authentication'],
      description:
        'Served by the authentication library, which owns its own routing, validation and response shapes under this prefix. Every path under it that is not documented here is answered 404.',
      responses: responsesOf(library, endpoint.path, method),
      security: SECURITY_FOR_SESSION[endpoint.session],
      ...(parameters.length > 0 && { parameters }),
      ...(body && { requestBody: body }),
    };
  };
  return Object.fromEntries(
    endpoint.methods.map((method) => [method.toLowerCase(), operation(method)])
  );
}

const NULLABLE_UUID: JsonSchema = {
  type: ['string', 'null'],
  pattern: UUID_V7_PATTERN,
};
const UUID: JsonSchema = {
  type: 'string',
  format: 'uuid',
  pattern: UUID_V7_PATTERN,
};

/** The tables that store the library's models in this deployment. */
const MODEL_TABLES: Readonly<Record<string, Table>> = {
  User: users,
  Session: sessions,
  Passkey: passkeys,
};

function orNull(property: JsonSchema): JsonSchema {
  if (typeof property.type === 'string')
    return { ...property, type: [property.type, 'null'] };
  if (Array.isArray(property.type))
    return property.type.includes('null')
      ? property
      : { ...property, type: [...property.type, 'null'] };
  return { anyOf: [property, { type: 'null' }] };
}

/**
 * A model's fields as its table stores them: the generator declares an
 * optional field as its bare type, but the adapter returns a NULL column as
 * `null`, and a field with no column is never returned. A `narrowed` field
 * replaces the stored one.
 */
function asStored(
  name: string,
  schema: JsonSchema,
  narrowed: JsonSchema = {}
): JsonSchema {
  const table = MODEL_TABLES[name];
  if (!table)
    throw new Error(
      `Better Auth's document references components.schemas '${name}', which no table here stores.`
    );
  const columns = getTableColumns(table);
  const properties = isJsonSchema(schema.properties) ? schema.properties : {};
  const stored = Object.entries(properties).filter(([field]) =>
    Object.hasOwn(columns, field)
  );
  return {
    ...schema,
    properties: {
      ...Object.fromEntries(
        stored.map(([field, property]) => [
          field,
          columns[field]?.notNull || !isJsonSchema(property)
            ? property
            : orNull(property),
        ])
      ),
      ...narrowed,
    },
    ...(Array.isArray(schema.required) && {
      required: schema.required.filter((field) =>
        stored.some(([kept]) => kept === field)
      ),
    }),
  };
}

/**
 * A `required` list the generator puts beside a model `$ref`, cut to the
 * fields `asStored` keeps: the passkey list names `updatedAt`, which the
 * library's `Passkey` model, and so the adapter's output, lacks.
 */
function storedRequired(library: Library, schema: JsonSchema): JsonSchema {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonSchema(value)) return value;
    const visited = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)])
    );
    const name =
      typeof value.$ref === 'string'
        ? /^#\/components\/schemas\/(.+)$/.exec(value.$ref)?.[1]
        : undefined;
    const model = name === undefined ? undefined : library.schemas[name];
    if (
      name === undefined ||
      !isJsonSchema(model) ||
      !Array.isArray(value.required)
    )
      return visited;
    const stored = asStored(name, model).properties;
    return {
      ...visited,
      required: value.required.filter(
        (field) =>
          typeof field === 'string' &&
          isJsonSchema(stored) &&
          Object.hasOwn(stored, field)
      ),
    };
  };
  return visit(schema) as JsonSchema;
}

/**
 * The page-keyed matrix session metadata carries, not the role's row list. An
 * action the page does not offer is `false` (`sanitizePermissions`), or
 * absent from the copy `db/migrations/003_grant_media_to_system_roles.sql`
 * patched in.
 */
const PERMISSION_MATRIX: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    DEFAULT_PAGE_PERMISSIONS.map(({ name, availablePermissions }) => [
      name,
      {
        type: 'object',
        properties: Object.fromEntries(
          PERMISSION_ACTION_NAMES.map((action) => [
            action,
            availablePermissions.includes(action)
              ? { type: 'boolean' }
              : { const: false },
          ])
        ),
        additionalProperties: false,
        required: [...availablePermissions],
      },
    ])
  ),
  additionalProperties: false,
};

/**
 * The library's schemas the paths reference, transitively, as stored, and
 * narrowed where this deployment is stricter.
 */
function referencedLibrarySchemas(
  library: Library,
  paths: JsonSchema
): JsonSchema {
  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) visit(item);
    if (!isJsonSchema(value)) return;
    const name =
      typeof value.$ref === 'string'
        ? /^#\/components\/schemas\/(.+)$/.exec(value.$ref)?.[1]
        : undefined;
    if (name && !referenced.has(name) && isJsonSchema(library.schemas[name])) {
      referenced.add(name);
      visit(library.schemas[name]);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(paths);

  const narrowed: Record<string, JsonSchema> = {
    User: {
      id: UUID,
      email: { type: 'string', format: 'email' },
      roleId: NULLABLE_UUID,
    },
    Session: {
      id: UUID,
      userId: UUID,
      // Not null, although the column is: `session.create` in
      // `lib/auth/session/hooks.ts` writes it on every session.
      metadata: {
        type: 'object',
        properties: {
          roleId: NULLABLE_UUID,
          roleName: { type: ['string', 'null'] },
          roleScope: {
            type: ['string', 'null'],
            enum: [...roleScope.enumValues, null],
          },
          permissions: PERMISSION_MATRIX,
        },
        additionalProperties: false,
        default: {},
        readOnly: true,
      },
    },
  };
  return Object.fromEntries(
    [...referenced].map((name) => {
      const schema = library.schemas[name];
      if (!isJsonSchema(schema)) return [name, schema];
      return [name, asStored(name, schema, narrowed[name])];
    })
  );
}

export async function mergeBetterAuth(): Promise<MergedPaths> {
  const library = await libraryDocument();
  const paths: JsonSchema = Object.fromEntries(
    BETTER_AUTH_ENDPOINTS.map((endpoint) => [
      `${BETTER_AUTH_ROUTE_PREFIX.prefix}${endpoint.path}`,
      pathItem(library, endpoint),
    ])
  );
  // Published only when an operation requires it: Redocly's `minimal` set
  // warns on an unused scheme, which two-factor switched off leaves.
  const challenged = BETTER_AUTH_ENDPOINTS.some((endpoint) =>
    SECURITY_FOR_SESSION[endpoint.session].some((entry) =>
      Object.hasOwn(entry, 'twoFactorChallengeCookie')
    )
  );
  return {
    paths,
    schemas: referencedLibrarySchemas(library, paths),
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: library.sessionCookie,
      },
      ...(challenged && {
        twoFactorChallengeCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: library.challengeCookie,
          description:
            'Issued by a first factor that needs a second one, and required by every operation that completes the challenge.',
        },
      }),
    },
  };
}
