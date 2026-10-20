/**
 * The generated document: built from the registered bindings, valid for both
 * validators, silent while it builds, and complete for every
 * binding. `GET /openapi.json` serves it (`lib/http/openapi/serve.ts`).
 */
import { Glob } from 'bun';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import type { JsonSchema } from '@/lib/http/openapi/json-schema';

import { app } from '@/app';
import { REGISTERED_BINDINGS } from '@/modules';
import { generateDocument } from '@/server/elysia/openapi';
import * as z from 'zod';

import { PROBLEM_MEDIA_TYPE } from '@app/shared/api/wire';
import { MSG_CHANNEL_DISABLED } from '@app/shared/messages/otp';
import { MAX_DOCUMENT_SIZE_MB, MIB } from '@app/shared/validation/constants';
import { OTP_CHANNELS } from '@app/shared/validation/enums';
import { mediaListQuerySchema } from '@app/shared/validation/media';
import { ALLOWED_MIME_TYPES } from '@app/shared/validation/media-types';
import { isChannelEnabled, sendOtpSchema } from '@app/shared/validation/otp';
import { TWO_FACTOR_ENABLED } from '@app/shared/validation/two-factor';

import {
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_ROUTE_PREFIX,
} from '@/lib/auth/allowed-paths';
import {
  attachFieldDocs,
  DOCS_VALUES,
  FIELD_DOCS_MODULES,
  fillPlaceholders,
} from '@/lib/http/openapi/docs';
import { requestBody } from '@/lib/http/openapi/finalize';
import { branchKey, isJsonSchema } from '@/lib/http/openapi/json-schema';
import { refusalsOf } from '@/lib/http/refusals';
import { generateUuidV7 } from '@/lib/id';

import { compareCodeUnits } from '@/utils/text';

import {
  redoclyProblems,
  validateWithSwaggerParser,
} from '../helpers/openapi-validity';

const SHARED_SRC = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src'
);

const state: { document: JsonSchema; warnings: unknown[][] } = {
  document: {},
  warnings: [],
};

const warn = spyOn(console, 'warn');

beforeAll(async () => {
  warn.mockImplementation((...args: unknown[]) => {
    state.warnings.push(args);
  });
  state.document = await generateDocument(app, REGISTERED_BINDINGS);
  warn.mockRestore();
});

afterAll(() => {
  warn.mockRestore();
});

const sorted = (values: Iterable<string>) =>
  [...values].toSorted(compareCodeUnits);

const pathsOf = (): Record<string, unknown> =>
  isJsonSchema(state.document.paths) ? state.document.paths : {};

function operation(binding: (typeof REGISTERED_BINDINGS)[number]): JsonSchema {
  const item = pathsOf()[binding.entry.path.replaceAll(/:(\w+)/g, '{$1}')];
  const found = isJsonSchema(item)
    ? item[binding.entry.method.toLowerCase()]
    : undefined;
  if (!isJsonSchema(found)) throw new Error(`${binding.key} is not documented`);
  return found;
}

describe('the generated document', () => {
  test('builds without a single generation warning', () => {
    expect(state.warnings).toEqual([]);
  });

  test('is valid for swagger-parser', async () => {
    await validateWithSwaggerParser(state.document);
  });

  test('is valid for Redocly’s minimal ruleset, with no warning', async () => {
    expect(await redoclyProblems(state.document)).toEqual([]);
  });

  test('holds no development path, no HEAD operation and no Better Auth wildcard', () => {
    const paths = Object.keys(pathsOf());
    expect(paths.filter((name) => name.startsWith('/api/dev'))).toEqual([]);
    expect(paths.filter((name) => name.includes('*'))).toEqual([]);
    for (const item of Object.values(pathsOf()))
      expect(isJsonSchema(item) && 'head' in item).toBe(false);
  });

  test('names no schema by id: every reference resolves', () => {
    expect(JSON.stringify(state.document)).not.toContain('"$defs"');
  });

  test('a node whose type admits null lets null through its enum or const', () => {
    const refusing: string[] = [];
    let nullableEnums = 0;
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries())
          walk(item, `${at}/${index}`);
        return;
      }
      if (!isJsonSchema(node)) return;
      if (Array.isArray(node.type) && node.type.includes('null')) {
        if (Array.isArray(node.enum)) {
          nullableEnums += 1;
          if (!node.enum.includes(null)) refusing.push(`${at} enum`);
        }
        if ('const' in node && node.const !== null)
          refusing.push(`${at} const`);
      }
      for (const [key, child] of Object.entries(node))
        walk(child, `${at}/${key}`);
    };
    walk(state.document, '#');
    expect(refusing).toEqual([]);
    expect(nullableEnums).toBeGreaterThan(0);
  });

  test('a body field the converter cannot represent stops the build', () => {
    expect(() => requestBody(z.object({ at: z.date() }), 'json')).toThrow();
  });

  test('a success that sets cookies publishes `Set-Cookie`, and no other does', () => {
    const setsCookies = REGISTERED_BINDINGS.filter((binding) => {
      const responses = operation(binding).responses;
      const success = isJsonSchema(responses)
        ? responses[String(binding.entry.status)]
        : undefined;
      const headers = isJsonSchema(success) ? success.headers : undefined;
      return isJsonSchema(headers) && 'Set-Cookie' in headers;
    }).map((binding) => binding.key);
    expect(setsCookies).toEqual([
      'PUT /api/dash/users/me',
      'POST /api/dash/users/me/change-email',
      'POST /api/dash/users/me/change-email/verify',
    ]);
  });

  test('publishes each upload’s one file field with its limits, as the legacy document does', () => {
    const uploads = REGISTERED_BINDINGS.filter(
      ({ entry }) => entry.bodyKind === 'multipart'
    );
    expect(uploads).toHaveLength(2);
    for (const binding of uploads) {
      const body = operation(binding).requestBody;
      const content = isJsonSchema(body) ? body.content : undefined;
      const media = isJsonSchema(content)
        ? content['multipart/form-data']
        : undefined;
      const schema = isJsonSchema(media) ? media.schema : undefined;
      const properties = isJsonSchema(schema) ? schema.properties : undefined;
      const fields = isJsonSchema(properties) ? Object.values(properties) : [];
      expect(fields).toHaveLength(1);
      expect(fields[0]).toMatchObject({
        type: 'string',
        format: 'binary',
        maxLength: MAX_DOCUMENT_SIZE_MB * MIB,
        'x-allowed-content-types': [...ALLOWED_MIME_TYPES],
      });
      expect(JSON.stringify(fields[0])).toContain('Exactly one file.');
    }
  });

  test('an OTP send publishes only the channels this deployment enables, a verify every channel', () => {
    const channelsOf = (key: string): string[] => {
      const binding = REGISTERED_BINDINGS.find((entry) => entry.key === key);
      if (!binding) throw new Error(`${key} is not registered`);
      const body = operation(binding).requestBody;
      const content = isJsonSchema(body) ? body.content : undefined;
      const media = isJsonSchema(content)
        ? content['application/json']
        : undefined;
      const schema = isJsonSchema(media) ? media.schema : undefined;
      const branches = isJsonSchema(schema) ? schema.oneOf : undefined;
      return sorted(
        (Array.isArray(branches) ? branches : []).map((branch) => {
          const properties = isJsonSchema(branch) ? branch.properties : {};
          const channel = isJsonSchema(properties)
            ? properties.channel
            : undefined;
          return isJsonSchema(channel) ? String(channel.const) : '';
        })
      );
    };
    const enabled = sorted(OTP_CHANNELS.filter(isChannelEnabled));
    // Non-vacuous only while some channel is off, as in the test environment.
    expect(enabled.length).toBeLessThan(OTP_CHANNELS.length);
    for (const key of [
      'POST /api/auth/otp/send',
      'POST /api/auth/forgot-password/send',
      'POST /api/auth/passwordless/send',
    ])
      expect(channelsOf(key)).toEqual(enabled);
    for (const key of [
      'POST /api/auth/otp/verify',
      'POST /api/auth/forgot-password/reset',
    ])
      expect(channelsOf(key)).toEqual(sorted(OTP_CHANNELS));

    // The runtime keeps every branch and its own refusal for a disabled one.
    const disabled = OTP_CHANNELS.find(
      (channel) => channel !== 'email' && !isChannelEnabled(channel)
    );
    const refused = sendOtpSchema.safeParse({
      channel: disabled,
      phoneNumber: '966500000001',
    });
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      MSG_CHANNEL_DISABLED,
    ]);
  });

  test('carries the field prose of the *.docs.ts files', () => {
    expect(JSON.stringify(state.document)).toContain(
      'Users holding this role, soft-deleted users excluded.'
    );
  });
});

describe.each(
  REGISTERED_BINDINGS.map((binding) => [binding.key, binding] as const)
)('%s', (_key, binding) => {
  const { entry } = binding;

  test('publishes its success and every refusal its policy implies', () => {
    const responses = operation(binding).responses;
    expect(
      sorted(Object.keys(isJsonSchema(responses) ? responses : {}))
    ).toEqual(
      sorted(
        [
          entry.status,
          ...refusalsOf(binding).map((refusal) => refusal.status),
        ].map(String)
      )
    );
  });

  test('publishes its path and query parameters', () => {
    const parameters = operation(binding).parameters;
    const names = (Array.isArray(parameters) ? parameters : [])
      .filter(isJsonSchema)
      .map((parameter) => `${String(parameter.in)}:${String(parameter.name)}`);
    const expected = [
      ...entry.path.matchAll(/:(\w+)/g).map(([, name]) => `path:${name}`),
      ...(entry.query instanceof z.ZodObject
        ? Object.keys(entry.query.shape).map((name) => `query:${name}`)
        : []),
      ...(entry.policy.captcha ? ['header:x-captcha-response'] : []),
      ...Object.keys(binding.options.detail.requiredHeaders ?? {}).map(
        (name) => `header:${name}`
      ),
    ];
    expect(sorted(names)).toEqual(sorted(expected));
  });

  test('publishes its body, under its kind’s media type, with the keys a request cannot omit', () => {
    const body = operation(binding).requestBody;
    if (entry.bodyKind === 'none') {
      expect(body).toBeUndefined();
      return;
    }
    const content = isJsonSchema(body) ? body.content : undefined;
    const media = isJsonSchema(content)
      ? content[
          entry.bodyKind === 'json' ? 'application/json' : 'multipart/form-data'
        ]
      : undefined;
    const schema = isJsonSchema(media) ? media.schema : undefined;
    if (!isJsonSchema(schema)) throw new Error(`${binding.key} has no body`);

    // A union publishes one branch per option, in order.
    const declared = binding.options.detail.publishedBody ?? entry.body;
    const key = branchKey(schema);
    const branches = key === null ? undefined : schema[key];
    const pairs: [z.core.$ZodType | undefined, unknown][] =
      declared instanceof z.ZodUnion
        ? declared.options.map((option, index) => [
            option,
            Array.isArray(branches) ? branches[index] : undefined,
          ])
        : [[declared, schema]];
    expect(pairs.length).toBeGreaterThan(0);
    for (const [option, published] of pairs) {
      if (!(option instanceof z.ZodObject) || !isJsonSchema(published))
        throw new Error(`${binding.key}: a body branch is not an object`);
      const required = Object.entries(option.shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([name]) => name);
      expect(
        Array.isArray(published.required)
          ? sorted(published.required.map(String))
          : []
      ).toEqual(sorted(required));
    }
  });
});

describe('the field docs', () => {
  test('the loader names every *.docs.ts file, and only those', () => {
    const onDisk = Iterator.from(new Glob('**/*.docs.ts').scanSync(SHARED_SRC))
      .map((file) => file.replaceAll(path.sep, '/').replace(/\.ts$/, ''))
      .toArray();
    expect(sorted(Object.keys(FIELD_DOCS_MODULES))).toEqual(sorted(onDisk));
  });

  test('two sentences for one field instance are refused', () => {
    const schema = z.object({ name: z.string() });
    attachFieldDocs({ schema, docs: { name: 'One.' } });
    attachFieldDocs({ schema, docs: { name: 'One.' } });
    expect(() => attachFieldDocs({ schema, docs: { name: 'Two.' } })).toThrow(
      'already reads "One."'
    );
  });

  test('a field the schema lacks is refused', () => {
    expect(() =>
      attachFieldDocs({ schema: z.object({}), docs: { gone: 'x' } })
    ).toThrow('which the schema lacks');
  });

  test('a bare instance takes one sentence, and the field holding it shares it', () => {
    const shared = z.string();
    attachFieldDocs({ schema: shared, description: 'One.' });
    expect(z.toJSONSchema(z.object({ a: shared })).properties).toEqual({
      a: { type: 'string', description: 'One.' },
    });
    expect(() =>
      attachFieldDocs({ schema: z.object({ a: shared }), docs: { a: 'Two.' } })
    ).toThrow('already reads "One."');
  });

  test('every placeholder a sentence names is filled, and every value is named', async () => {
    const modules = await Promise.all(
      Object.values(FIELD_DOCS_MODULES).map((load) => load())
    );
    const sentences = modules
      .flatMap(({ docs }) => docs)
      .flatMap((entry) =>
        'description' in entry
          ? [entry.description]
          : Object.values(entry.docs).filter((text) => text !== undefined)
      );
    const named = sentences.flatMap((sentence) =>
      sentence
        .matchAll(/\{\{(\w+)\}\}/g)
        .map(([, name]) => name ?? '')
        .toArray()
    );
    expect(sorted(new Set(named))).toEqual(sorted(Object.keys(DOCS_VALUES)));
    expect(fillPlaceholders('up to {{folderSearchLimit}} folders')).toBe(
      `up to ${DOCS_VALUES.folderSearchLimit} folders`
    );
    expect(() => fillPlaceholders('{{nothingFillsThis}}')).toThrow(
      'which nothing fills'
    );
    expect(JSON.stringify(state.document)).not.toMatch(/\{\{\w+\}\}/);
  });
});

describe('what the generated document says', () => {
  const op = (path: string, method: string): JsonSchema => {
    const item = pathsOf()[path];
    const found = isJsonSchema(item) ? item[method] : undefined;
    if (!isJsonSchema(found)) throw new Error(`${method} ${path} is missing`);
    return found;
  };
  const json = (value: unknown, ...keys: string[]): unknown =>
    keys.reduce<unknown>(
      (node, key) => (isJsonSchema(node) ? node[key] : undefined),
      value
    );
  const statuses = (operation: JsonSchema) =>
    sorted(
      Object.keys(isJsonSchema(operation.responses) ? operation.responses : {})
    );

  test('the readiness probe publishes its raw bodies, its token header and no limiter', () => {
    const operation = op('/api/health/storage', 'get');
    expect(statuses(operation)).toEqual([
      '200',
      '401',
      '413',
      '422',
      '500',
      '503',
    ]);
    const body = (status: string) =>
      json(
        operation,
        'responses',
        status,
        'content',
        'application/json',
        'schema'
      );
    expect(json(body('200'), 'required')).toEqual(['status', 'checks']);
    expect(json(body('401'), 'properties', 'status', 'const')).toBe(
      'unauthorized'
    );
    const unavailable = json(body('503'), 'oneOf');
    expect(
      (Array.isArray(unavailable) ? unavailable : []).map((branch) =>
        json(branch, 'properties', 'status', 'const')
      )
    ).toEqual(['degraded', 'error']);
    expect(json(operation, 'responses', '503', 'headers')).toBeUndefined();
    expect(operation.security).toEqual([]);
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'x-maintenance-token',
          in: 'header',
          required: true,
        }),
        expect.objectContaining({
          name: 'deep',
          in: 'query',
          description: expect.stringContaining('Set to 1'),
        }),
      ])
    );
  });

  test('the document route publishes its raw success shape and problem refusals', () => {
    const operation = op('/openapi.json', 'get');
    expect(statuses(operation)).toEqual([
      '200',
      '401',
      '403',
      '413',
      '429',
      '500',
      '503',
    ]);
    expect(
      json(
        operation,
        'responses',
        '200',
        'content',
        'application/json',
        'schema',
        'required'
      )
    ).toEqual(['openapi', 'info', 'servers', 'tags', 'components', 'paths']);
    expect(
      json(operation, 'responses', '401', 'content', PROBLEM_MEDIA_TYPE)
    ).toEqual({ schema: { $ref: '#/components/schemas/Problem' } });
    expect(operation.security).toEqual([{ sessionCookie: [] }]);
  });

  test('every operation keeps the identifier the document has always published', () => {
    const ids = Object.values(pathsOf()).flatMap((item) =>
      Object.values(isJsonSchema(item) ? item : {}).map((operation) =>
        String(json(operation, 'operationId'))
      )
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(json(op('/api/dash/users/{id}', 'get'), 'operationId')).toBe(
      'get_api_dash_users__id'
    );
    expect(json(op('/api/auth/sign-in/email', 'post'), 'operationId')).toBe(
      'betterAuth_post_sign_in_email'
    );
  });

  test('no subschema names a dialect, and parameter prose sits on the parameter', () => {
    expect(JSON.stringify(state.document)).not.toContain('"$schema"');
    const sort = (op('/api/dash/users', 'get').parameters as JsonSchema[]).find(
      (parameter) => parameter.name === 'sort'
    );
    expect(sort?.description).toContain('Allowed ids: `name`');
    expect(json(sort, 'schema', 'description')).toBeUndefined();
  });

  test('a route a newer one replaces is marked deprecated, and only those', () => {
    const deprecated = Object.entries(pathsOf()).flatMap(([path, item]) =>
      Object.entries(isJsonSchema(item) ? item : {})
        .filter(([, operation]) => json(operation, 'deprecated') === true)
        .map(([method]) => `${method} ${path}`)
    );
    expect(sorted(deprecated)).toEqual(
      sorted(['delete /api/dash/media/files', 'put /api/dash/media/files'])
    );
  });

  test('document rules the schemas carry are published: non-empty updates, the OTP enrolment rule', () => {
    const body = (path: string, method: string) =>
      json(
        op(path, method),
        'requestBody',
        'content',
        'application/json',
        'schema'
      );
    expect(json(body('/api/dash/media/files/{id}', 'put'), 'anyOf')).toEqual([
      { required: ['displayName'] },
      { required: ['folderId'] },
    ]);
    expect(json(body('/api/dash/media/folders/{id}', 'put'), 'anyOf')).toEqual([
      { required: ['name'] },
      { required: ['parentId'] },
    ]);
    for (const path of [
      '/api/auth/two-factor/methods/disable',
      '/api/auth/two-factor/methods/default',
    ]) {
      expect(path in pathsOf(), path).toBe(TWO_FACTOR_ENABLED);
      if (!TWO_FACTOR_ENABLED) continue;
      expect(JSON.stringify(body(path, 'post'))).toContain(
        '"then":{"properties":{"contactKind":{}},"required":["contactKind"]}'
      );
    }
  });

  test('the Better Auth merge publishes exactly the allowlist, under its own schemes', () => {
    const ours = new Set(REGISTERED_BINDINGS.map(({ entry }) => entry.path));
    const merged = Object.keys(pathsOf()).filter(
      (path) =>
        path.startsWith(BETTER_AUTH_ROUTE_PREFIX.prefix) && !ours.has(path)
    );
    expect(sorted(merged)).toEqual(
      sorted(
        BETTER_AUTH_ENDPOINTS.map(
          (endpoint) => `${BETTER_AUTH_ROUTE_PREFIX.prefix}${endpoint.path}`
        )
      )
    );
    expect(
      Object.keys(
        json(state.document, 'components', 'securitySchemes') as JsonSchema
      )
    ).toEqual(['sessionCookie', 'twoFactorChallengeCookie']);
  });

  const parameter = (path: string, name: string): unknown => {
    const { parameters } = op(path, 'get');
    return (Array.isArray(parameters) ? parameters : []).find(
      (found: unknown) => json(found, 'name') === name
    );
  };
  const success = (path: string, method: string, status = '200') =>
    json(
      op(path, method),
      'responses',
      status,
      'content',
      'application/json',
      'schema',
      'properties',
      'data'
    );

  test('the user detail publishes that its first sessions page comes whole or not at all', () => {
    expect(
      json(success('/api/dash/users/{id}', 'get'), 'dependentRequired')
    ).toEqual({
      sessions: ['sessionsHasMore', 'sessionsNextCursor'],
      sessionsHasMore: ['sessions', 'sessionsNextCursor'],
      sessionsNextCursor: ['sessions', 'sessionsHasMore'],
    });
  });

  test('the lists and the readiness probe publish an example of their query', () => {
    for (const path of [
      '/api/dash/users',
      '/api/dash/permissions',
      '/api/dash/media',
    ])
      expect(json(parameter(path, 'sort'), 'schema', 'examples')).toEqual([
        '[{"id":"createdAt","desc":true}]',
      ]);
    expect(
      json(parameter('/api/health/storage', 'deep'), 'schema', 'examples')
    ).toEqual(['1']);
  });

  test('the media listing publishes every folder value the server reads, the empty root included', () => {
    const schema = json(parameter('/api/dash/media', 'folder'), 'schema');
    if (!isJsonSchema(schema)) throw new Error('folder is not published');
    const published = z.fromJSONSchema(schema);
    const id = generateUuidV7();
    for (const value of ['', id, ` ${id.toUpperCase()} `, 'root', `${id}x`])
      expect(published.safeParse(value).success, value).toBe(
        mediaListQuerySchema.shape.folder.safeParse(value).success
      );
    expect(published.safeParse('').success).toBe(true);
  });

  test('prose on a reused or whole schema is published', () => {
    const body = (path: string, method: string) =>
      json(
        op(path, method),
        'requestBody',
        'content',
        'application/json',
        'schema'
      );
    expect(
      json(body('/api/dash/users', 'post'), 'properties', 'permissions')
    ).toMatchObject({ description: expect.stringContaining('unique') });
    for (const path of [
      '/api/dash/media/folders/{id}',
      '/api/dash/media/files/{id}',
    ])
      expect(json(body(path, 'put'), 'description')).toContain(
        'At least one property'
      );
    const uploaded = success('/api/upload/file', 'post', '201');
    expect(json(uploaded, 'description')).toContain('One pending file');
    expect(json(uploaded, 'items', 'properties', 'url', 'description')).toBe(
      json(
        success('/api/dash/media/files/{id}', 'get'),
        'properties',
        'url',
        'description'
      )
    );
    expect(json(success('/api/dash/media/stats', 'get'), 'description')).toBe(
      'Every folder, and the active files the library governs with their bytes.'
    );
    const views = json(success('/api/dash/media', 'get'), 'oneOf');
    expect(
      (Array.isArray(views) ? views : []).map((view) =>
        String(json(view, 'description')).slice(0, 18)
      )
    ).toEqual([
      'The folder view (`',
      'The library search',
      'The unfiled view (',
    ]);
    expect(
      json(
        state.document,
        'components',
        'schemas',
        'MediaRefusalProblem',
        'properties',
        'data',
        'description'
      )
    ).toContain('blocked a media refusal');
  });
});
