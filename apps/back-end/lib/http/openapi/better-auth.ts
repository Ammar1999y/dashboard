/**
 * The operations served under the Better Auth prefix: the library's own
 * generated document, merged with the corrections this deployment needs.
 */
import type { HttpMethod, RoutePrefixPath } from '../route-manifest';
import type { JsonSchema } from './json-schema';
import type * as z from 'zod';

import { roleScope } from '@/db/schema';

import { BETTER_AUTH_BODIES } from '@app/shared/contract';
import { UUID_V7_PATTERN } from '@app/shared/utils';
import {
  CONTACT_KINDS,
  OTP_CHANNELS,
  TWO_FACTOR_METHODS,
} from '@app/shared/validation/enums';

import { auth } from '@/lib/auth';
import { TWO_FACTOR_COOKIE_NAME } from '@/lib/auth/two-factor/challenge';

import { bodyPolicyCeiling } from '../request';
import {
  CAPTCHA_HEADER_PARAMETER,
  NULLABLE_STRING_SCHEMA,
  USER_PERMISSION_MATRIX_SCHEMA,
  UUID_SCHEMA,
} from './components';
import { bodyTooLargeResponse, PRE_AUTH_RESPONSES } from './envelope';
import { isJsonSchema, normalizeOpenApi31 } from './json-schema';
import { requestBody } from './request-bodies';

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

export const BETTER_AUTH_SUMMARIES: Record<string, string> = {
  'GET /capabilities': 'Read enabled OAuth sign-in providers',
  'GET /reauth/methods': 'Read usable reauthentication methods',
  'POST /reauth/passkey/options': 'Start passkey reauthentication',
  'POST /reauth/passkey/verify': 'Complete passkey reauthentication',
  'POST /oauth/google/start': 'Start Google sign-in',
  'GET /oauth/google/callback': 'Complete the verified Google exchange',
  'GET /oauth/result': 'Consume the Google redirect result',
  'GET /get-session': 'Get the current Better Auth session',
  'POST /sign-out': 'Sign out the current session',
  'POST /sign-in/email': 'Sign in with email and password',
  'POST /passwordless/verify': 'Verify a passwordless sign-in code',
  'POST /two-factor/disable': 'Disable two-factor authentication',
  'POST /two-factor/get-totp-uri': 'Get the TOTP enrolment URI',
  'POST /two-factor/totp/start': 'Begin authenticator-app enrolment',
  'POST /two-factor/totp/confirm': 'Confirm authenticator-app enrolment',
  'POST /two-factor/verify-totp': 'Verify a TOTP code',
  'POST /two-factor/generate-backup-codes': 'Generate new backup codes',
  'POST /two-factor/verify-backup-code': 'Verify a backup code',
  'POST /two-factor/otp/send': 'Send a second-factor code',
  'POST /two-factor/otp/verify': 'Verify a second-factor code',
  'POST /two-factor/passkey/options': 'Start a passkey second-factor ceremony',
  'POST /two-factor/passkey/verify': 'Verify a passkey second factor',
  'POST /two-factor/trust-device': 'Trust this device for two-factor',
  'GET /two-factor/trusted-devices': 'List trusted devices',
  'POST /two-factor/trusted-devices/revoke': 'Revoke a trusted device',
  'GET /two-factor/methods': 'List enrolled second factors',
  'POST /two-factor/methods/disable': 'Remove one second factor',
  'POST /two-factor/methods/default': 'Choose the default second factor',
  'POST /two-factor/passkey/grant': 'Re-authenticate before a passkey ceremony',
  'POST /two-factor/backup-codes/acknowledge':
    'Confirm the backup codes were saved',
  'GET /passkey/generate-register-options': 'Start passkey registration',
  'POST /passkey/verify-registration': 'Complete passkey registration',
  'GET /passkey/list-user-passkeys': 'List the user’s passkeys',
  'POST /passkey/delete-passkey': 'Delete a passkey',
  'POST /passkey/update-passkey': 'Rename a passkey',
};

const BETTER_AUTH_STATUS_DESCRIPTIONS = {
  '404':
    'The Better Auth endpoint is unavailable in the current feature configuration.',
  '500': 'Better Auth, or one of its dependencies, failed.',
  '400': 'Required request input was absent or invalid for this endpoint.',
  '401':
    'Credentials refused, or the session this request would create is not allowed to exist (inactive user, inactive role).',
  '403':
    'Captcha verification failed, the request origin is not trusted, or the account has an unverified contact channel.',
  '422':
    'The submitted fields failed this project’s own schema for the endpoint.',
  '409':
    'The request would leave the account in a state this application refuses — removing the only enrolled second factor.',
} as const;

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

/**
 * Statuses reachable on some allowlisted paths only, keyed like
 * `BETTER_AUTH_BODIES`. `/get-session` is a GET, so the origin check that
 * produces 403 does not apply and an absent session is a 200 carrying `null`;
 * the paths that create a session run the `session.create` hook in
 * `lib/auth/index.ts`, which is what can refuse 401 or 403.
 */
export const BETTER_AUTH_PATH_STATUSES: Record<
  string,
  readonly (keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS)[]
> = {
  '/capabilities': [],
  '/reauth/methods': ['401'],
  '/reauth/passkey/options': ['400', '401', '403'],
  '/reauth/passkey/verify': ['400', '401', '403'],
  '/oauth/google/start': ['400', '401', '403'],
  '/oauth/google/callback': ['400', '401'],
  '/oauth/result': ['401'],
  '/sign-in/email': ['400', '401', '403', '422'],
  '/sign-out': ['400', '403'],
  '/passwordless/verify': ['400', '401', '403', '422'],
  // 403 on the POST paths is Better Auth's origin check (`validateOrigin`),
  // which refuses a cookie-bearing call with no `origin` before the handler
  // runs. GET paths skip that check.
  '/two-factor/disable': ['401', '403', '422'],
  '/two-factor/get-totp-uri': ['401', '403', '422'],
  // 409 is the refusal to replace an authenticator that already works.
  '/two-factor/totp/start': ['401', '403', '404', '409', '422'],
  '/two-factor/totp/confirm': ['400', '401', '403', '404', '409', '422'],
  '/two-factor/verify-totp': ['400', '403', '422'],
  '/two-factor/generate-backup-codes': ['401', '403', '404', '422'],
  '/two-factor/verify-backup-code': ['400', '403', '422'],
  '/two-factor/otp/send': ['400', '401', '403', '422'],
  '/two-factor/otp/verify': ['400', '401', '403', '422'],
  '/two-factor/passkey/options': ['400', '401', '403', '422'],
  '/two-factor/passkey/verify': ['400', '401', '403', '422'],
  '/two-factor/trust-device': ['401', '403', '422'],
  '/two-factor/trusted-devices': ['401'],
  '/two-factor/trusted-devices/revoke': ['401', '403', '422'],
  '/two-factor/methods': ['401'],
  // 409 is the last-method refusal.
  '/two-factor/methods/disable': ['401', '403', '404', '409', '422'],
  '/two-factor/methods/default': ['401', '403', '404', '422'],
  '/two-factor/passkey/grant': ['401', '403', '404', '422'],
  // 409 is the refusal to acknowledge a set another tab has already replaced.
  '/two-factor/backup-codes/acknowledge': ['401', '403', '409', '422'],
  '/passkey/generate-register-options': ['401'],
  // 409 is a credential deleted between the library's write and the enrolment
  // hook, which leaves nothing to offer as a factor.
  '/passkey/verify-registration': ['400', '401', '403', '409', '422'],
  '/passkey/list-user-passkeys': ['401'],
  // 404 is a passkey that is not the caller's; 409 the last-method refusal.
  '/passkey/delete-passkey': ['400', '401', '403', '404', '409', '422'],
  '/passkey/update-passkey': ['400', '401', '403', '422'],
};

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

/**
 * Paths that throttle inside the endpoint as well as at the wildcard's
 * admission limiter, and so answer 429/503 in two body shapes: the wildcard's
 * goes to `handleApiError` (envelope), an inner `CustomError` to
 * `toAuthApiError`.
 */
const BETTER_AUTH_LOCAL_THROTTLE_PATHS = new Set([
  '/reauth/passkey/options',
  '/reauth/passkey/verify',
  '/passwordless/verify',
  // `enforceOtpSurfaceSendQuota` / `enforceOtpVerifyQuota`.
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

/** Widen one admission-limiter response to admit Better Call's shape too. */
function withBetterAuthErrorShape(
  response: unknown,
  detail: string
): JsonSchema {
  if (!isJsonSchema(response)) return BETTER_AUTH_ERROR_SCHEMA;
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
        // `anyOf`: the envelope satisfies the Better Call shape too, so
        // exactly-one would fail on the body the limiter actually sends.
        schema: { anyOf: [json.schema, BETTER_AUTH_ERROR_SCHEMA] },
      },
    },
  };
}

const TWO_FACTOR_OPTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Stable option identity: `totp`, `backup_code`, `passkey`, `otp:email` or `otp:phone`.',
    },
    method: {
      type: 'string',
      enum: [...TWO_FACTOR_METHODS],
    },
    contactKind: {
      anyOf: [{ type: 'string', enum: [...CONTACT_KINDS] }, { type: 'null' }],
    },
    channel: {
      anyOf: [{ type: 'string', enum: [...OTP_CHANNELS] }, { type: 'null' }],
    },
    nextAllowedIn: {
      type: 'integer',
      minimum: 0,
      description:
        '`otp` options only: seconds before a code may be sent to this contact. `0` means a send is allowed now.',
    },
  },
  required: ['id', 'method', 'contactKind', 'channel'],
};

/**
 * The second 200 both first-factor endpoints can answer. Not in Better Auth's
 * generated contract: the plugin's challenge hook is replaced
 * (`twoFactorSignInGuard`) and `/passwordless/verify` is this project's
 * endpoint. Without it a generated client reads the challenge as a session.
 */
const TWO_FACTOR_CHALLENGE_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'The first factor succeeded and the login is NOT complete: no session cookie is set, and one of the options below has to be verified next.',
  properties: {
    twoFactorRedirect: { const: true },
    twoFactorMethods: {
      type: 'array',
      items: {
        type: 'string',
        enum: [...TWO_FACTOR_METHODS],
      },
      description:
        'Distinct method names. Two OTP channels collapse into one entry here, so it cannot drive a choice — use `twoFactorOptions`.',
    },
    twoFactorOptions: { type: 'array', items: TWO_FACTOR_OPTION_SCHEMA },
    defaultMethod: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        '`null` means ask: only recovery material is left, and a backup code is never auto-routed to.',
    },
  },
  required: [
    'twoFactorRedirect',
    'twoFactorMethods',
    'twoFactorOptions',
    'defaultMethod',
  ],
};

/** The paths whose 200 is a union of "signed in" and "challenged". */
const TWO_FACTOR_CHALLENGE_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/passwordless/verify',
]);

/** Widens one 200 to admit the challenge branch alongside the completed one. */
function withTwoFactorChallengeBranch(response: unknown): JsonSchema {
  if (!isJsonSchema(response))
    return {
      content: {
        'application/json': { schema: TWO_FACTOR_CHALLENGE_SCHEMA },
      },
    };
  const content = isJsonSchema(response.content) ? response.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  return {
    ...response,
    description:
      `${String(response.description ?? '')} A two-factor account is answered with the challenge branch instead, and no session cookie.`.trim(),
    content: {
      ...content,
      'application/json': {
        ...json,
        // `anyOf`: the two shapes share no required key, so a client can tell
        // them apart on `twoFactorRedirect` alone.
        schema: { anyOf: [json.schema, TWO_FACTOR_CHALLENGE_SCHEMA] },
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
 * A path's 200 where the library's generated document is wrong about it. Both
 * verifiers answer through the shared `valid()` in
 * `better-auth/plugins/two-factor/verify-two-factor.mjs`, which returns
 * `{ token, user }`, not the shapes the plugin's metadata declares.
 *
 * ⚠️ Every served success response must be overridden here or listed in
 * `BETTER_AUTH_TRUSTED_RESPONSES`; `tests/unit/openapi-contract.test.ts`
 * refuses a path in neither.
 */
const BETTER_AUTH_RESPONSES: Record<string, JsonSchema> = {
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

/**
 * Paths whose generated 200 was read and found to match what is served. An
 * explicit attestation, so "unchecked" and "checked and correct" differ.
 */
export const BETTER_AUTH_TRUSTED_RESPONSES: ReadonlySet<string> = new Set([
  '/capabilities',
  '/reauth/methods',
  '/reauth/passkey/options',
  '/reauth/passkey/verify',
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/passwordless/verify',
  '/oauth/google/start',
  '/oauth/google/callback',
  '/oauth/result',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/totp/start',
  '/two-factor/totp/confirm',
  '/two-factor/trust-device',
  '/two-factor/trusted-devices',
  '/two-factor/trusted-devices/revoke',
  '/two-factor/methods',
  '/two-factor/methods/disable',
  '/two-factor/methods/default',
  '/two-factor/backup-codes/acknowledge',
  '/two-factor/generate-backup-codes',
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
  '/two-factor/passkey/grant',
  '/two-factor/passkey/options',
  '/two-factor/passkey/verify',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);

export const BETTER_AUTH_OVERRIDDEN_RESPONSES: ReadonlySet<string> = new Set(
  Object.keys(BETTER_AUTH_RESPONSES)
);

function betterAuthResponses(path: string, method: HttpMethod): JsonSchema {
  const statuses = [
    '200',
    '404',
    '500',
    ...(BETTER_AUTH_PATH_STATUSES[path] ?? []),
  ];
  const responses: JsonSchema = { ...PRE_AUTH_RESPONSES };

  if (BETTER_AUTH_LOCAL_THROTTLE_PATHS.has(path)) {
    responses['429'] = withBetterAuthErrorShape(
      responses['429'],
      'The endpoint’s own per-destination verify quota answers here too, in Better Auth’s error shape.'
    );
    responses['503'] = withBetterAuthErrorShape(
      responses['503'],
      'That quota is fail-closed, so a degraded limiter store refuses here in Better Auth’s error shape.'
    );
  }

  for (const status of statuses) {
    const generated =
      status === '200' && path in BETTER_AUTH_RESPONSES
        ? BETTER_AUTH_RESPONSES[path]
        : generatedBetterAuthResponse(
            path,
            method,
            status === '422' ? '400' : status
          );
    responses[status] = {
      ...generated,
      ...(isDescribedStatus(status) && {
        description: BETTER_AUTH_STATUS_DESCRIPTIONS[status],
      }),
    };
  }

  // The boundary in `app.ts` refuses these before the library reads the body,
  // so the answer is this project's envelope. ⚠️ `ROUTE_PREFIXES`' body policy
  // for `/api/auth` is restated here as `'json'`; changing it there must change
  // it here.
  if (method === 'POST')
    responses['413'] = bodyTooLargeResponse(bodyPolicyCeiling('json'));

  if (
    path === '/oauth/google/callback' ||
    path === '/oauth/result' ||
    (method === 'POST' && TWO_FACTOR_CHALLENGE_PATHS.has(path))
  )
    responses['200'] = withTwoFactorChallengeBranch(responses['200']);

  if (path === '/oauth/google/callback')
    responses['302'] = {
      description:
        'Return to the validated same-origin callbackURL, without codes or tokens. Fetch /api/auth/oauth/result with cookies to consume the result.',
      headers: { Location: { schema: { type: 'string', format: 'uri' } } },
    };

  return responses;
}

const BETTER_AUTH_PREFIX = '/api/auth';

/** The document path of a Better Auth endpoint. */
export function betterAuthDocumentPath(path: string): string {
  return `${BETTER_AUTH_PREFIX}${path}`;
}

/** Only the methods the path declares, each a fresh operation with its own id. */
export function betterAuthPathItem(endpoint: RoutePrefixPath): JsonSchema {
  const schema = betterAuthBodies[endpoint.path];
  const slug = endpoint.path.replaceAll(/[^a-zA-Z0-9]/g, '_');

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
    if (endpoint.captcha) parameters.push(CAPTCHA_HEADER_PARAMETER);
    if (parameters.length > 0) operation.parameters = parameters;
    // A request body is published on POST only; on GET it describes a request
    // no client can make.
    if (schema && method === 'POST') {
      const body = requestBody(schema, `${method} ${endpoint.path}`);
      if (body) operation.requestBody = body;
    } else if (method === 'POST' && isJsonSchema(generated?.requestBody)) {
      const normalized = normalizeOpenApi31(generated.requestBody);
      if (isJsonSchema(normalized)) operation.requestBody = normalized;
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
        image: { type: ['string', 'null'] },
        roleId: {
          type: ['string', 'null'],
          pattern: UUID_V7_PATTERN,
        },
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
            roleId: { type: ['string', 'null'], pattern: UUID_V7_PATTERN },
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
