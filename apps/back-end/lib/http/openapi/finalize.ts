/**
 * The generated document, finished from what the framework's generator cannot
 * see: request bodies read by the gate's `parse` hook, the `required` keys of
 * a preprocessed field, header parameters, refusal wording, problems and
 * response headers, the success rules `.meta()` cannot carry, and the
 * operations Better Auth serves.
 * Works on plain objects, so it stays core.
 */
import type { AnyBinding } from '../binding';
import type { JsonSchema } from './json-schema';
import type { EndpointResponse } from '@app/shared/api/endpoint';
import type { OpenApiDocument } from '@app/shared/responses/openapi';

import packageManifest from '@/package.json';
import * as z from 'zod';

import { isRawResponse } from '@app/shared/api/endpoint';
import {
  authProblemSchema,
  plainProblemSchema,
  PROBLEM_MEDIA_TYPE,
  problemSchema,
  problemSchemaOf,
} from '@app/shared/api/wire';
import { OPENAPI_VERSION } from '@app/shared/responses/openapi';
import {
  USER_DETAIL_SESSION_KEYS,
  userDetailSchema,
} from '@app/shared/responses/users';
import {
  CAPTCHA_HEADER,
  CAPTCHA_TOKEN_MAX_LENGTH,
} from '@app/shared/validation/auth';

import { refusalsOf } from '../refusals';
import { isJsonSchema, withNullInEnums, withRequiredKeys } from './json-schema';
import { OPERATION_TAGS } from './tags';

/** What the framework's generator returns. */
export interface GeneratedDocument {
  paths: Record<string, unknown>;
  components: { schemas?: unknown };
}

/** The operations, schemas and schemes merged in from Better Auth. */
export interface MergedPaths {
  paths: JsonSchema;
  schemas: JsonSchema;
  securitySchemes: JsonSchema;
}

export const RESPONSE_HEADERS = {
  'Retry-After': {
    description: 'Seconds until the caller should retry.',
    schema: { type: 'integer', minimum: 1 },
  },
  'X-RateLimit-Limit': {
    description: 'Request or cost budget for the active window.',
    schema: { type: 'integer', minimum: 1 },
  },
  'X-RateLimit-Remaining': {
    description: 'Budget remaining in the active window.',
    schema: { type: 'integer', minimum: 0 },
  },
} satisfies Record<string, JsonSchema>;

export const CAPTCHA_HEADER_PARAMETER: JsonSchema = {
  name: CAPTCHA_HEADER,
  in: 'header',
  required: true,
  description: 'Cloudflare Turnstile response token.',
  schema: { type: 'string', minLength: 1, maxLength: CAPTCHA_TOKEN_MAX_LENGTH },
};

/** Published once each under `components`; every refusal references one. */
const PROBLEMS = {
  Problem: plainProblemSchema,
  MediaRefusalProblem: problemSchema,
  AuthProblem: authProblemSchema,
} as const;

/** A refusal's content: `schema` by reference. */
export function problemContent(schema: z.ZodType): JsonSchema {
  const name = Object.entries(PROBLEMS).find(
    ([, problem]) => problem === schema
  )?.[0];
  if (name === undefined) throw new Error('Not a published problem.');
  return {
    [PROBLEM_MEDIA_TYPE]: { schema: { $ref: `#/components/schemas/${name}` } },
  };
}

/** `get_api_dash_users__id`: the identifiers the document has always published. */
export const operationIdOf = (method: string, path: string): string =>
  `${method.toLowerCase()}${path.replaceAll(/[^a-zA-Z0-9]/g, '_')}`;

const openApiPath = (path: string) => path.replaceAll(/:(\w+)/g, '{$1}');

/** `$schema` names a schema resource root; spliced in as a subschema it does not belong. */
function withoutDialect(schema: unknown): unknown {
  if (!isJsonSchema(schema)) return schema;
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

/**
 * Throws on a schema the converter cannot represent, so the document never
 * publishes `{}` for a field the server parses.
 */
export function publishedSchema(
  schema: z.ZodType,
  io: 'input' | 'output' = 'output'
): JsonSchema {
  const { $schema: _dialect, ...converted } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'throw',
  });
  return converted;
}

const BODY_MEDIA_TYPES = {
  json: 'application/json',
  multipart: 'multipart/form-data',
} as const;

export function requestBody(
  schema: z.ZodType,
  kind: keyof typeof BODY_MEDIA_TYPES
): JsonSchema {
  return {
    required: true,
    content: {
      [BODY_MEDIA_TYPES[kind]]: {
        schema: withRequiredKeys(schema, publishedSchema(schema, 'input')),
      },
    },
  };
}

function operationOf(
  paths: Record<string, unknown>,
  binding: AnyBinding
): JsonSchema {
  const item = paths[openApiPath(binding.entry.path)];
  const operation = isJsonSchema(item)
    ? item[binding.entry.method.toLowerCase()]
    : undefined;
  if (!isJsonSchema(operation))
    throw new Error(`${binding.key} is missing from the generated document.`);
  return operation;
}

/**
 * The generator leaves a field's prose inside the parameter's schema; a
 * reader looks for it on the parameter, where the route adds its own.
 */
function finishParameters(
  operation: JsonSchema,
  binding: AnyBinding
): JsonSchema[] {
  const { detail } = binding.options;
  const generated = Array.isArray(operation.parameters)
    ? operation.parameters.filter(isJsonSchema)
    : [];
  const parameters = generated.map((parameter): JsonSchema => {
    const schema = withoutDialect(parameter.schema);
    const own =
      isJsonSchema(schema) && typeof schema.description === 'string'
        ? schema.description
        : undefined;
    const added =
      parameter.in === 'query' && typeof parameter.name === 'string'
        ? detail.parameters?.[parameter.name]
        : undefined;
    const description = [own, added].filter(Boolean).join(' ');
    if (description === '' || !isJsonSchema(schema))
      return { ...parameter, schema };
    const { description: _moved, ...rest } = schema;
    return { ...parameter, description, schema: rest };
  });
  const headers = Object.entries(detail.requiredHeaders ?? {});
  for (const [name, description] of headers)
    parameters.push({
      name,
      in: 'header',
      required: true,
      description,
      schema: { type: 'string', minLength: 1 },
    });
  if (binding.entry.policy.captcha) parameters.push(CAPTCHA_HEADER_PARAMETER);
  return parameters;
}

/** All present or none: each key requires the others. */
const allOrNone = (keys: readonly string[]): JsonSchema =>
  Object.fromEntries(
    keys.map((key) => [key, keys.filter((other) => other !== key)])
  );

/**
 * Rules a success's `data` publishes that `.meta()` cannot carry: the
 * contract's own check reads each response schema back through
 * `z.fromJSONSchema`, which refuses these keywords.
 */
const DATA_KEYWORDS = new Map<EndpointResponse, JsonSchema>([
  [
    userDetailSchema,
    { dependentRequired: allOrNone(USER_DETAIL_SESSION_KEYS) },
  ],
]);

function successData(response: JsonSchema, binding: AnyBinding): JsonSchema {
  const content = isJsonSchema(response.content)
    ? response.content['application/json']
    : undefined;
  const schema = isJsonSchema(content) ? content.schema : undefined;
  const properties = isJsonSchema(schema) ? schema.properties : undefined;
  const data = isJsonSchema(properties) ? properties.data : undefined;
  if (!isJsonSchema(data))
    throw new Error(`${binding.key} publishes no success data.`);
  return data;
}

function finishOperation(operation: JsonSchema, binding: AnyBinding): void {
  const { entry } = binding;
  const { detail } = binding.options;
  operation.operationId = operationIdOf(entry.method, entry.path);
  if (detail.deprecated) operation.deprecated = true;
  // Neither kind reaches the framework's generator: a JSON body is read by
  // the gate's `parse` hook, a form by the handler.
  if (entry.bodyKind !== 'none' && entry.body)
    operation.requestBody = requestBody(
      detail.publishedBody ?? entry.body,
      entry.bodyKind
    );
  const parameters = finishParameters(operation, binding);
  if (parameters.length > 0) operation.parameters = parameters;
  operation.security =
    entry.policy.auth === 'public' ? [] : [{ sessionCookie: [] }];

  const responses = isJsonSchema(operation.responses)
    ? operation.responses
    : {};
  const describe = (
    status: number,
    derived: string,
    headers: readonly (keyof typeof RESPONSE_HEADERS)[] = []
  ) => {
    const response = responses[String(status)];
    if (!isJsonSchema(response))
      throw new Error(`${binding.key} publishes no ${status}.`);
    response.description = detail.responses?.[status] ?? derived;
    if (headers.length > 0)
      response.headers = Object.fromEntries(
        headers.map((name) => [name, RESPONSE_HEADERS[name]])
      );
    if (isJsonSchema(response.content))
      for (const media of Object.values(response.content))
        if (isJsonSchema(media)) media.schema = withoutDialect(media.schema);
    return response;
  };
  const success = describe(entry.status, 'Success.');
  const keywords = DATA_KEYWORDS.get(entry.response);
  if (keywords) Object.assign(successData(success, binding), keywords);
  if (detail.setCookie !== undefined)
    success.headers = {
      'Set-Cookie': {
        description: detail.setCookie,
        schema: { type: 'string' },
      },
    };
  const raw = isRawResponse(entry.response)
    ? (entry.response.refusals ?? {})
    : {};
  for (const { status, description, headers } of refusalsOf(binding)) {
    const response = describe(status, description, headers);
    if (!Object.hasOwn(raw, status))
      response.content = problemContent(problemSchemaOf(entry, status));
  }
}

const SCHEMA_REF = /"#\/components\/schemas\/([^"]+)"/g;

/** The component schemas `root` references, directly or through each other. */
function referencedSchemas(root: unknown, schemas: JsonSchema): JsonSchema {
  const kept = new Map<string, unknown>();
  let frontier: unknown[] = [root];
  while (frontier.length > 0) {
    const names = frontier.flatMap((node) =>
      JSON.stringify(node)
        .matchAll(SCHEMA_REF)
        .map(([, name]) => name ?? '')
        .toArray()
    );
    frontier = [];
    for (const name of names)
      if (!kept.has(name) && Object.hasOwn(schemas, name)) {
        kept.set(name, schemas[name]);
        frontier.push(schemas[name]);
      }
  }
  return Object.fromEntries(kept);
}

export function finalizeDocument(
  generated: GeneratedDocument,
  bindings: readonly AnyBinding[],
  merged: MergedPaths
): OpenApiDocument {
  for (const binding of bindings)
    finishOperation(operationOf(generated.paths, binding), binding);

  // The merge replaces whole path items, so a shared path would drop the
  // binding's operations whatever the methods.
  for (const path of Object.keys(merged.paths))
    if (Object.hasOwn(generated.paths, path))
      throw new Error(
        `${path} is published by a binding and by the Better Auth prefix.`
      );
  const paths = withNullInEnums({ ...generated.paths, ...merged.paths });
  const schemas = withNullInEnums({
    ...(isJsonSchema(generated.components.schemas) &&
      generated.components.schemas),
    ...merged.schemas,
    ...Object.fromEntries(
      Object.entries(PROBLEMS).map(([name, schema]) => [
        name,
        publishedSchema(schema),
      ])
    ),
  });

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Dashboard API',
      version: packageManifest.version,
      license: {
        name: 'Private; redistribution is not licensed',
        identifier: 'LicenseRef-Proprietary',
      },
      description:
        'Generated from the server’s own bindings and the schemas they validate with, so it describes what the deployment actually serves. Not hand-maintained.',
    },
    servers: [
      { url: '/', description: 'The same origin that served this document.' },
    ],
    tags: OPERATION_TAGS.map((tag) => ({ ...tag })),
    paths,
    components: {
      schemas: referencedSchemas(paths, schemas),
      securitySchemes: merged.securitySchemes,
    },
  };
}
