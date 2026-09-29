import type { JsonSchema } from './json-schema';
import type { BodySchemas } from '@app/shared/contract';
import type * as z from 'zod';

import { PHONE_ENABLED, PHONE_REQUIRED } from '@app/shared/config';
import { REQUEST_BODIES } from '@app/shared/contract';
import {
  CUSTOM_ROLE_VALUE,
  PERMISSION_ACTIONS,
} from '@app/shared/permissions/constants';
import {
  MAX_DOCUMENT_SIZE_MB,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  MIB,
} from '@app/shared/validation/constants';
import {
  ALLOWED_MIME_TYPES,
  mimeTypesOfKind,
} from '@app/shared/validation/media-types';
import { isChannelEnabled } from '@app/shared/validation/otp';

import { NULL_SCHEMA } from './components';
import {
  branchKey,
  isJsonSchema,
  toJsonSchema,
  withRequiredKeys,
} from './json-schema';

/**
 * `REQUEST_BODIES` with its keys widened to `string`, because the document
 * looks routes up from the manifest rather than naming them.
 */
export const requestBodies: Readonly<Record<string, BodySchemas>> =
  REQUEST_BODIES;

/**
 * Multipart request bodies, keyed like `REQUEST_BODIES`. Per route because the
 * two upload routes read different field names, and a client sending the wrong
 * one is answered "no file".
 */
export const MULTIPART_BODIES: Record<
  string,
  { field: string; description: string }
> = {
  'POST /api/upload/file': {
    field: 'files',
    description: 'The file, for the record named by `resource` and `purpose`.',
  },
  'POST /api/dash/media/files': {
    field: 'file',
    description:
      'The file, stored privately in the folder named by `folder`. A deployment with no private bucket answers 422.',
  },
};

/**
 * The routes whose schema carries `channelEnabledRefine`. Not the verifies:
 * those deliberately accept a channel disabled since the code was delivered, so
 * narrowing them would publish a refusal the runtime does not make.
 */
export const OTP_SEND_ROUTES = new Set([
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/otp/send',
  'POST /api/auth/passwordless/send',
]);

/** Better Auth paths, keyed like `BETTER_AUTH_SUMMARIES`, that name ONE enrolment. */
const OTP_CONTACT_KIND_ROUTES = new Set([
  'POST /two-factor/methods/disable',
  'POST /two-factor/methods/default',
]);

/** The routes whose body is a partial update that must not be empty. */
const NON_EMPTY_UPDATE_ROUTES = new Set([
  'PUT /api/dash/media/folders/:id',
  'PUT /api/dash/media/files/:id',
]);

function permissionDependencyRule(
  actions: readonly string[],
  requiredReadActions: readonly string[]
): JsonSchema {
  const anyTrue = (names: readonly string[]): JsonSchema => {
    const branches = names.map((action) => ({
      properties: { [action]: { const: true } },
      required: [action],
    }));
    return branches.length === 1 && branches[0]
      ? branches[0]
      : { anyOf: branches };
  };
  return {
    if: {
      properties: {
        permissions: anyTrue(actions),
      },
      required: ['permissions'],
    },
    // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
    then: {
      properties: {
        permissions: anyTrue(requiredReadActions),
      },
    },
  };
}

function addPagePermissionRules(schema: JsonSchema): JsonSchema {
  if (!isJsonSchema(schema.properties)) return schema;
  const permissions = schema.properties.permissions;
  if (!isJsonSchema(permissions)) return schema;
  const items = permissions.items;
  if (!isJsonSchema(items)) return schema;

  permissions.description =
    'Page names must be unique. Unsupported actions may be omitted or false, never true.';
  permissions['x-unique-by'] = 'name';
  items.allOf = [
    permissionDependencyRule(['edit', 'delete', 'publish'], ['view']),
    permissionDependencyRule(['editOwn', 'deleteOwn'], ['view', 'viewOwn']),
    {
      if: {
        properties: { name: { const: 'home' } },
        required: ['name'],
      },
      // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
      then: {
        properties: {
          permissions: {
            properties: Object.fromEntries(
              Object.keys(PERMISSION_ACTIONS)
                .filter((action) => action !== 'view')
                .map((action) => [action, { const: false }])
            ),
          },
        },
      },
    },
  ];
  return schema;
}

function addUserRoleRules(schema: JsonSchema, update: boolean): JsonSchema {
  const customThen: JsonSchema = {
    properties: { permissions: { minItems: 1 } },
    ...(!update && { required: ['permissions'] }),
  };
  const rules: JsonSchema[] = [
    {
      if: {
        properties: { roleId: { const: CUSTOM_ROLE_VALUE } },
        required: ['roleId'],
      },
      // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
      then: customThen,
      else: { properties: { permissions: { maxItems: 0 } } },
    },
  ];

  if (!PHONE_ENABLED)
    rules.push({
      properties: {
        phoneNumber: {
          description: 'Phone input is disabled; omit this field or clear it.',
        },
      },
    });
  else if (PHONE_REQUIRED)
    rules.push({
      properties: {
        phoneNumber: { not: NULL_SCHEMA },
      },
      ...(!update && { required: ['phoneNumber'] }),
    });

  return {
    ...schema,
    allOf: [...(Array.isArray(schema.allOf) ? schema.allOf : []), ...rules],
  };
}

/**
 * Drops the union branches whose channel this deployment does not accept — the
 * refinement `z.toJSONSchema` cannot see.
 */
function restrictToEnabledChannels(schema: JsonSchema): JsonSchema {
  const key = branchKey(schema);
  const branches = key === null ? null : schema[key];
  if (key === null || !Array.isArray(branches)) return schema;

  const kept = branches.filter((branch) => {
    if (!isJsonSchema(branch) || !isJsonSchema(branch.properties)) return true;
    const channel = branch.properties.channel;
    if (!isJsonSchema(channel) || typeof channel.const !== 'string')
      return true;
    return isChannelEnabled(channel.const);
  });

  // Nothing left means `OTP_ENABLED` is false and the route 404s before it
  // reads a body; an empty `oneOf` is not a valid schema.
  if (kept.length === 0 || kept.length === branches.length) return schema;
  return { ...schema, [key]: kept };
}

/**
 * `contactKind` is required when `method` is `otp`: a user may hold an
 * `otp:email` and an `otp:phone` enrolment at once, and the handler refuses
 * `{ method: 'otp' }` alone rather than resolving it by row order.
 */
function requireContactKindForOtp(schema: JsonSchema): JsonSchema {
  if (!isJsonSchema(schema.properties) || !schema.properties['contactKind'])
    return schema;
  const existing = Array.isArray(schema.allOf) ? schema.allOf : [];
  return {
    ...schema,
    allOf: [
      ...existing,
      {
        if: { properties: { method: { const: 'otp' } }, required: ['method'] },
        // eslint-disable-next-line unicorn/no-thenable -- JSON Schema 2020-12 keyword paired with `if`, not a promise
        then: { required: ['contactKind'] },
      },
    ],
  };
}

/**
 * The `.refine` that makes an empty body invalid, which the converter drops.
 * `anyOf` rather than `minProperties`: with `additionalProperties: false`
 * already set, naming the keys says which ones count.
 */
function requireAtLeastOneProperty(schema: JsonSchema): JsonSchema {
  if (!isJsonSchema(schema.properties)) return schema;
  const names = Object.keys(schema.properties);
  if (names.length === 0) return schema;
  return {
    ...schema,
    anyOf: names.map((name) => ({ required: [name] })),
    description:
      `${String(schema.description ?? '')} At least one property must be present; an empty object is rejected.`.trim(),
  };
}

/**
 * On update the matrix is a full replacement: the handler deletes every page
 * absent from the array and still answers 200. Not in `addPagePermissionRules`,
 * because on create there is nothing to replace.
 */
function addMatrixReplacementNote(schema: JsonSchema): JsonSchema {
  if (!isJsonSchema(schema.properties)) return schema;
  const permissions = schema.properties.permissions;
  if (!isJsonSchema(permissions)) return schema;

  permissions.description =
    `${String(permissions.description ?? '')} This is the COMPLETE matrix and REPLACES the stored one: a page omitted from the array has its grants revoked. Omit the key entirely to leave the stored matrix unchanged.`.trim();
  return schema;
}

function applyRequestContractRules(
  key: string | undefined,
  schema: JsonSchema,
  branch: number
): JsonSchema {
  let result = addPagePermissionRules(schema);
  if (key === 'PUT /api/dash/permissions/:id')
    result = addMatrixReplacementNote(result);
  else if (key === 'POST /api/dash/users')
    result = addUserRoleRules(result, false);
  if (key === 'PUT /api/dash/users/:id' && branch === 0)
    result = addUserRoleRules(result, true);
  if (key !== undefined && OTP_SEND_ROUTES.has(key))
    result = restrictToEnabledChannels(result);
  if (key !== undefined && OTP_CONTACT_KIND_ROUTES.has(key))
    result = requireContactKindForOtp(result);
  if (key !== undefined && NON_EMPTY_UPDATE_ROUTES.has(key))
    result = requireAtLeastOneProperty(result);
  return result;
}

function isSchemaList(schemas: BodySchemas): schemas is readonly z.ZodType[] {
  return Array.isArray(schemas);
}

export function requestBody(
  schemas: BodySchemas,
  key?: string
): JsonSchema | null {
  const list = isSchemaList(schemas) ? schemas : [schemas];
  const converted = list
    .map((schema, index) => {
      const json = toJsonSchema(schema);
      return json === null
        ? null
        : applyRequestContractRules(key, withRequiredKeys(schema, json), index);
    })
    .filter((s): s is JsonSchema => s !== null);
  if (converted.length === 0) return null;

  const schema = converted.length === 1 ? converted[0] : { oneOf: converted };

  return {
    required: true,
    content: { 'application/json': { schema } },
  };
}

const UPLOAD_LIMITS_DESCRIPTION =
  `Exactly one file. Images (${mimeTypesOfKind('image').join(', ')}): at most ${MAX_IMAGE_SIZE} MiB, ` +
  `${MAX_IMAGE_PIXELS.toLocaleString('en-US')} decoded pixels and ${MAX_IMAGE_EDGE.toLocaleString('en-US')} pixels on either edge; ` +
  `PNG is re-encoded to WebP, SVG is sanitised. Documents (${mimeTypesOfKind('document').join(', ')}): at most ${MAX_DOCUMENT_SIZE_MB} MiB, ` +
  'byte-inspected: macro-enabled, template, encrypted and object-embedding variants are refused; field codes, external links and DDE are not inspected, and documents are always served as attachments, never rendered. ' +
  'Upload several files as sequential single-file requests with bounded concurrency and honour `Retry-After` on 429.';

export function multipartRequestBody(key: string): JsonSchema {
  const multipart = MULTIPART_BODIES[key];
  if (!multipart) throw new Error(`No multipart body for ${key}`);
  return {
    required: true,
    content: {
      'multipart/form-data': {
        schema: {
          type: 'object',
          properties: {
            [multipart.field]: {
              type: 'string',
              format: 'binary',
              'x-allowed-content-types': [...ALLOWED_MIME_TYPES],
              maxLength: MAX_DOCUMENT_SIZE_MB * MIB,
              description: `${multipart.description} ${UPLOAD_LIMITS_DESCRIPTION}`,
            },
          },
          required: [multipart.field],
          additionalProperties: false,
        },
      },
    },
  };
}
