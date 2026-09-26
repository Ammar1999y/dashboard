import type { JsonSchema } from './json-schema';

import { fileTransitionEnum } from '@/db/schema';

import {
  DASHBOARD_PAGE_NAMES,
  PERMISSION_ACTIONS,
} from '@app/shared/permissions/constants';
import { UUID_V7_PATTERN } from '@app/shared/utils';
import {
  CAPTCHA_HEADER,
  CAPTCHA_TOKEN_MAX_LENGTH,
} from '@app/shared/validation/auth';
import {
  FOLDER_NAME_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from '@app/shared/validation/constants';
import { BUCKET_TYPES, FILE_KINDS } from '@app/shared/validation/enums';
import { SESSION_CURSOR_PATTERN } from '@app/shared/validation/sessions';

import { KNOWN_MIME_TYPES } from '@/lib/media/allowlist';

export const UUID_SCHEMA: JsonSchema = {
  type: 'string',
  format: 'uuid',
  pattern: UUID_V7_PATTERN,
};
export const DATE_TIME_SCHEMA: JsonSchema = {
  type: 'string',
  format: 'date-time',
};
export const NULL_SCHEMA: JsonSchema = { type: 'null' };
export const NULLABLE_STRING_SCHEMA: JsonSchema = { type: ['string', 'null'] };
export const NULLABLE_CURSOR_SCHEMA: JsonSchema = {
  type: ['string', 'null'],
  pattern: SESSION_CURSOR_PATTERN,
};
const NULLABLE_UUID_SCHEMA: JsonSchema = { anyOf: [UUID_SCHEMA, NULL_SCHEMA] };

export const PAGINATION_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1 },
    perPage: { type: 'integer', minimum: 1 },
    total: { type: 'integer', minimum: 0 },
    pageCount: { type: 'integer', minimum: 0 },
  },
  required: ['page', 'perPage', 'total', 'pageCount'],
  additionalProperties: false,
};

const ERROR_ENVELOPE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    success: { const: false },
    message: { type: 'string' },
    code: {
      type: 'string',
      description:
        'Machine-readable error code when supplied. REAUTH_REQUIRED requests a password/passkey reauthentication proof. otp_proof_throttle identifies a proof-level OTP throttle at an authenticated boundary.',
    },
    data: NULL_SCHEMA,
  },
  required: ['success', 'message', 'data'],
  additionalProperties: false,
};

const PERMISSION_ACTION_PROPERTIES = Object.fromEntries(
  Object.keys(PERMISSION_ACTIONS).map((action) => [action, { type: 'boolean' }])
);
const PARTIAL_ACTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: PERMISSION_ACTION_PROPERTIES,
  additionalProperties: false,
};
const COMPLETE_ACTIONS_SCHEMA: JsonSchema = {
  ...PARTIAL_ACTIONS_SCHEMA,
  required: Object.keys(PERMISSION_ACTIONS),
};
export const PAGE_PERMISSION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', enum: [...DASHBOARD_PAGE_NAMES] },
    permissions: PARTIAL_ACTIONS_SCHEMA,
  },
  required: ['name', 'permissions'],
  additionalProperties: false,
};
/** The page-keyed shape session metadata carries, not the role's row list. */
export const USER_PERMISSION_MATRIX_SCHEMA: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    DASHBOARD_PAGE_NAMES.map((page) => [page, COMPLETE_ACTIONS_SCHEMA])
  ),
  additionalProperties: false,
};

export const BUCKET_TYPE_SCHEMA: JsonSchema = {
  type: 'string',
  enum: [...BUCKET_TYPES],
};

/**
 * The one file shape every media route returns. `url` is the permanent public
 * URL for a public object and a signed URL, valid for one hour, for anything
 * else; `transition` is non-null while a publish or unpublish is still copying.
 */
export const MEDIA_FILE_PROPERTIES = {
  id: UUID_SCHEMA,
  kind: { type: 'string', enum: [...FILE_KINDS] },
  displayName: { type: 'string', maxLength: MEDIA_DISPLAY_NAME_MAX },
  mimeType: { type: 'string', enum: [...KNOWN_MIME_TYPES] },
  sizeBytes: { type: 'integer', minimum: 0 },
  bucketType: BUCKET_TYPE_SCHEMA,
  transition: {
    anyOf: [{ type: 'string', enum: [...fileTransitionEnum] }, NULL_SCHEMA],
    description:
      'Non-null while a visibility change is in flight, and each value tells a client something different: `to_public`/`to_private` mean the copy is being made and verified and `url` still answers from the OLD bucket, so the change is in progress; `cleanup` means the flip is done and `url` is final, and only the stale copy in the other bucket (and, for a public one, its edge cache) is still being removed by the nightly sweep — nothing is pending for the client. `url` always points at the current bucket. Removing the object from the origin is unconditional; evicting an edge copy needs the configured cache purge; a copy already in a browser stays readable until its `Cache-Control` lifetime ends and cannot be recalled.',
  },
  width: { type: ['integer', 'null'], minimum: 1 },
  height: { type: ['integer', 'null'], minimum: 1 },
  blurhash: NULLABLE_STRING_SCHEMA,
  folderId: {
    ...NULLABLE_UUID_SCHEMA,
    description:
      'Null for a file uploaded for a record rather than into the library.',
  },
  uploadedBy: NULLABLE_UUID_SCHEMA,
  unfiledAt: {
    anyOf: [DATE_TIME_SCHEMA, NULL_SCHEMA],
    description:
      'When the nightly sweep first found the file unfiled — active, in no folder, referenced by no record. It is deleted `retentionDays` (see `scope=unfiled`) after this unless moved into a folder; null otherwise.',
  },
  url: {
    type: 'string',
    format: 'uri',
    description:
      'Permanent public URL for a public object; otherwise a signed URL valid for one hour. Never store it.',
  },
  createdAt: DATE_TIME_SCHEMA,
  updatedAt: DATE_TIME_SCHEMA,
} as const;

const MEDIA_FILE_REQUIRED: readonly (keyof typeof MEDIA_FILE_PROPERTIES)[] = [
  'id',
  'kind',
  'displayName',
  'mimeType',
  'sizeBytes',
  'bucketType',
  'transition',
  'width',
  'height',
  'blurhash',
  'folderId',
  'uploadedBy',
  'unfiledAt',
  'url',
  'createdAt',
  'updatedAt',
];

const MEDIA_FILE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: MEDIA_FILE_PROPERTIES,
  required: [...MEDIA_FILE_REQUIRED],
  additionalProperties: false,
};

export const MEDIA_FOLDER_PROPERTIES = {
  id: UUID_SCHEMA,
  name: { type: 'string', minLength: 1, maxLength: FOLDER_NAME_MAX },
  parentId: {
    ...NULLABLE_UUID_SCHEMA,
    description: 'Null for a root folder.',
  },
  createdBy: NULLABLE_UUID_SCHEMA,
  createdAt: DATE_TIME_SCHEMA,
  updatedAt: DATE_TIME_SCHEMA,
} as const;

const MEDIA_FOLDER_REQUIRED: readonly (keyof typeof MEDIA_FOLDER_PROPERTIES)[] =
  ['id', 'name', 'parentId', 'createdBy', 'createdAt', 'updatedAt'];

const MEDIA_FOLDER_SCHEMA: JsonSchema = {
  type: 'object',
  properties: MEDIA_FOLDER_PROPERTIES,
  required: [...MEDIA_FOLDER_REQUIRED],
  additionalProperties: false,
};

export const MEDIA_BREADCRUMB_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: UUID_SCHEMA,
    name: { type: 'string' },
  },
  required: ['id', 'name'],
  additionalProperties: false,
};

const MEDIA_FOLDER_HIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ...MEDIA_FOLDER_PROPERTIES,
    breadcrumbs: {
      type: 'array',
      items: MEDIA_BREADCRUMB_SCHEMA,
      description: 'Root → the folder itself.',
    },
  },
  required: [...MEDIA_FOLDER_REQUIRED, 'breadcrumbs'],
  additionalProperties: false,
};

const MEDIA_USAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    resource: { type: 'string', enum: [...DASHBOARD_PAGE_NAMES] },
    recordId: { type: 'string' },
  },
  required: ['label', 'resource', 'recordId'],
  additionalProperties: false,
};

const MEDIA_FILE_DETAILS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ...MEDIA_FILE_PROPERTIES,
    downloadUrl: {
      type: 'string',
      format: 'uri',
      description:
        'Signed URL, valid for one hour, that downloads the file under its current display name.',
    },
    usedBy: {
      type: 'array',
      items: MEDIA_USAGE_SCHEMA,
      description: 'Owners the caller may view.',
    },
    hiddenUsages: {
      type: 'integer',
      minimum: 0,
      description: 'Owners on pages the caller may not view.',
    },
  },
  required: [...MEDIA_FILE_REQUIRED, 'downloadUrl', 'usedBy', 'hiddenUsages'],
  additionalProperties: false,
};

/**
 * The project schemas published once under `components.schemas` and referenced
 * from every use. The literals above stay the source: two of these are built
 * from another's properties, and a `$ref` cannot be spread.
 *
 * `satisfies` rather than an annotation, so `keyof` stays the literal names and
 * `componentRef` refuses a name this object does not define.
 */
export const COMPONENT_SCHEMAS = {
  MediaFile: MEDIA_FILE_SCHEMA,
  MediaFileDetails: MEDIA_FILE_DETAILS_SCHEMA,
  MediaFolder: MEDIA_FOLDER_SCHEMA,
  MediaFolderHit: MEDIA_FOLDER_HIT_SCHEMA,
  MediaUsage: MEDIA_USAGE_SCHEMA,
  ErrorEnvelope: ERROR_ENVELOPE_SCHEMA,
} satisfies Record<string, JsonSchema>;

export function componentRef(name: keyof typeof COMPONENT_SCHEMAS): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

export const CAPTCHA_HEADER_PARAMETER: JsonSchema = {
  name: CAPTCHA_HEADER,
  in: 'header',
  required: true,
  description: 'Cloudflare Turnstile response token.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: CAPTCHA_TOKEN_MAX_LENGTH,
  },
};
