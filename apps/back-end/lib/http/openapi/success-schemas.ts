import type { JsonSchema } from './json-schema';

import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  PRESET_NAME_MAX,
} from '@app/shared/validation/constants';
import {
  COLOR_MODES,
  PRESET_NAME_PATTERN,
  THEME_LAYOUTS,
} from '@app/shared/validation/preferences';

import { OTP_BASE_RESEND_DELAY_S } from '@/lib/otp/throttle';

import {
  BUCKET_TYPE_SCHEMA,
  componentRef,
  DATE_TIME_SCHEMA,
  MEDIA_BREADCRUMB_SCHEMA,
  MEDIA_FILE_PROPERTIES,
  MEDIA_FOLDER_PROPERTIES,
  NULL_SCHEMA,
  NULLABLE_CONTACT_KIND_SCHEMA,
  NULLABLE_CURSOR_SCHEMA,
  NULLABLE_DEFAULT_METHOD_SCHEMA,
  NULLABLE_OTP_CHANNEL_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  PAGE_PERMISSION_SCHEMA,
  UUID_SCHEMA,
} from './components';

const ROLE_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: UUID_SCHEMA,
    roleName: { type: 'string' },
  },
  required: ['id', 'roleName'],
  additionalProperties: false,
};
const NULLABLE_ROLE_SUMMARY_SCHEMA: JsonSchema = {
  anyOf: [ROLE_SUMMARY_SCHEMA, NULL_SCHEMA],
};
const ROLE_ID_SCHEMA: JsonSchema = {
  anyOf: [UUID_SCHEMA, { const: CUSTOM_ROLE_VALUE }],
};
const NULLABLE_ROLE_ID_SCHEMA: JsonSchema = {
  anyOf: [UUID_SCHEMA, { const: CUSTOM_ROLE_VALUE }, NULL_SCHEMA],
};

const SESSION_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: UUID_SCHEMA,
    ipAddress: NULLABLE_STRING_SCHEMA,
    userAgent: NULLABLE_STRING_SCHEMA,
    createdAt: DATE_TIME_SCHEMA,
    isCurrent: { type: 'boolean' },
  },
  required: ['id', 'ipAddress', 'userAgent', 'createdAt', 'isCurrent'],
  additionalProperties: false,
};
const UPDATED_AT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { updatedAt: DATE_TIME_SCHEMA },
  required: ['updatedAt'],
  additionalProperties: false,
};
const CREATED_ID_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { id: UUID_SCHEMA },
  required: ['id'],
  additionalProperties: false,
};
const OTP_SENT_SCHEMA: JsonSchema = {
  type: 'object',
  // A `const`, and it has to stay one: the anonymous surfaces answer identically
  // for a real and an invented identifier, so the value cannot vary with the
  // row. Only the `FLAT_RESEND_PURPOSES` qualify; a surface that returns its
  // row's own countdown uses `OTP_LADDER_SENT_SCHEMA`.
  properties: { nextAllowedIn: { const: OTP_BASE_RESEND_DELAY_S } },
  required: ['nextAllowedIn'],
  additionalProperties: false,
};
/**
 * For surfaces reached after proving something — a session or a recovery grant
 * — which return the row's real exponential delay. `lib/auth/two-factor/otp.ts`
 * publishes the same shape for `/two-factor/otp/send`.
 */
const OTP_LADDER_SENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    nextAllowedIn: { type: 'integer', minimum: OTP_BASE_RESEND_DELAY_S },
  },
  required: ['nextAllowedIn'],
  additionalProperties: false,
};
const VERIFIED_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { verified: { const: true } },
  required: ['verified'],
  additionalProperties: false,
};
const CONTACT_CHANGE_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { autoVerified: { const: true } },
      required: ['autoVerified'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { otpSent: { const: true } },
      required: ['otpSent'],
      additionalProperties: false,
    },
  ],
};

/** Mirrors `preferencesSchema` key for key; a field added there is added here. */
const PREFERENCES_DOCUMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    preset: {
      type: 'string',
      maxLength: PRESET_NAME_MAX,
      pattern: PRESET_NAME_PATTERN,
      description:
        'A theme preset the client resolves. It falls back to its built-in theme for one it does not know, so this server does not hold the list.',
    },
    colorMode: { type: 'string', enum: [...COLOR_MODES] },
    themeLayout: { type: 'string', enum: [...THEME_LAYOUTS] },
    fontScale: {
      type: 'number',
      minimum: FONT_SCALE_MIN,
      maximum: FONT_SCALE_MAX,
    },
    containerStretch: { type: 'boolean' },
  },
  required: [
    'preset',
    'colorMode',
    'themeLayout',
    'fontScale',
    'containerStretch',
  ],
  additionalProperties: false,
};

const PREFERENCES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    preferences: PREFERENCES_DOCUMENT_SCHEMA,
    updatedAt: {
      anyOf: [DATE_TIME_SCHEMA, NULL_SCHEMA],
      description:
        'Server-side write time. Null only when nothing has ever been saved, so a stored choice of the defaults is distinguishable from no choice.',
    },
  },
  required: ['preferences', 'updatedAt'],
  additionalProperties: false,
};

const RECOVERY_OPTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    method: { type: 'string', enum: ['totp', 'otp', 'backup_code'] },
    contactKind: NULLABLE_CONTACT_KIND_SCHEMA,
    channel: NULLABLE_OTP_CHANNEL_SCHEMA,
  },
  required: ['id', 'method', 'contactKind', 'channel'],
  additionalProperties: false,
};

const RESET_DONE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { reset: { const: true } },
  required: ['reset'],
  additionalProperties: false,
};

/**
 * An account with a second factor never gets `reset: true` from `/reset`: it
 * gets a grant, and `/complete` writes the password against a proven factor.
 */
const RESET_OUTCOME_SCHEMA: JsonSchema = {
  anyOf: [
    RESET_DONE_SCHEMA,
    {
      type: 'object',
      properties: {
        reset: { const: false },
        twoFactorRequired: { const: true },
        grant: { type: 'string' },
        options: { type: 'array', items: RECOVERY_OPTION_SCHEMA },
        defaultMethod: NULLABLE_DEFAULT_METHOD_SCHEMA,
      },
      required: [
        'reset',
        'twoFactorRequired',
        'grant',
        'options',
        'defaultMethod',
      ],
      additionalProperties: false,
    },
  ],
};

/** What every list response carries about this deployment's capabilities. */
const MEDIA_CAPABILITY_PROPERTIES = {
  visibilities: {
    type: 'array',
    items: BUCKET_TYPE_SCHEMA,
    uniqueItems: true,
    description: 'The buckets this deployment has configured.',
  },
  canPublish: {
    type: 'boolean',
    description: 'Whether the caller holds `media.publish`.',
  },
} as const;

const MEDIA_LIST_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      description:
        'The folder view (`scope=folder`): breadcrumbs from the root, the subfolders, and one page of files.',
      properties: {
        ...MEDIA_CAPABILITY_PROPERTIES,
        breadcrumbs: { type: 'array', items: MEDIA_BREADCRUMB_SCHEMA },
        folders: { type: 'array', items: componentRef('MediaFolder') },
        files: { type: 'array', items: componentRef('MediaFile') },
      },
      required: [
        'visibilities',
        'canPublish',
        'breadcrumbs',
        'folders',
        'files',
      ],
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'The library search (`scope=all`): one page of files across every folder and, when `search` is given, up to twenty folders whose name matches, each with its path from the root.',
      properties: {
        ...MEDIA_CAPABILITY_PROPERTIES,
        files: { type: 'array', items: componentRef('MediaFile') },
        folders: {
          type: 'array',
          items: componentRef('MediaFolderHit'),
        },
        foldersTruncated: {
          type: 'boolean',
          description:
            'More folders match than the twenty returned. The files beside them are fully paginated through `meta`; the folder hits are a navigation aid and are capped, so a narrower `search` is the way to reach the rest.',
        },
      },
      required: [
        'visibilities',
        'canPublish',
        'files',
        'folders',
        'foldersTruncated',
      ],
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'The unfiled view (`scope=unfiled`): one page of active files in no folder that no record references — uploads whose record is gone. Each is deleted `retentionDays` after its `unfiledAt` stamp unless moved into a folder with `PUT /api/dash/media/files/{id}`.',
      properties: {
        ...MEDIA_CAPABILITY_PROPERTIES,
        files: { type: 'array', items: componentRef('MediaFile') },
        retentionDays: {
          type: 'integer',
          minimum: 1,
          description: 'Days an unfiled file survives after `unfiledAt`.',
        },
      },
      required: ['visibilities', 'canPublish', 'files', 'retentionDays'],
      additionalProperties: false,
    },
  ],
};

/** One shape for both delete modes, empty folder or subtree. */
const FOLDER_DELETE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    folders: {
      type: 'integer',
      minimum: 0,
      description:
        'Folder rows removed. `0` from a recursive delete whose FILES went but whose folders could not: something was still in the tree — a file the sweep has yet to finish removing, or an upload that arrived while the files were being deleted. Retry once it settles.',
    },
    deleted: {
      type: 'array',
      items: UUID_SCHEMA,
      uniqueItems: true,
      description:
        'Files gone from the database and from the object store. Always empty for a non-recursive delete, which refuses a folder that holds anything.',
    },
    pending: {
      type: 'array',
      items: UUID_SCHEMA,
      uniqueItems: true,
      description:
        'Files committed to deletion and already gone from every listing, whose object or configured cache purge the nightly sweep still has to finish.',
    },
  },
  required: ['folders', 'deleted', 'pending'],
  additionalProperties: false,
};

export const SUCCESS_DATA_SCHEMAS: Record<string, JsonSchema> = {
  'POST /api/auth/forgot-password/reset': RESET_OUTCOME_SCHEMA,
  'POST /api/auth/forgot-password/second-factor/send': OTP_LADDER_SENT_SCHEMA,
  'POST /api/auth/forgot-password/complete': RESET_DONE_SCHEMA,
  'POST /api/auth/forgot-password/send': OTP_SENT_SCHEMA,
  'POST /api/auth/otp/send': OTP_SENT_SCHEMA,
  'POST /api/auth/otp/verify': VERIFIED_SCHEMA,
  'POST /api/auth/passwordless/send': OTP_SENT_SCHEMA,
  'POST /api/dash/auth/reauth': {
    type: 'object',
    properties: {
      expiresIn: {
        type: 'integer',
        description:
          'Seconds the window lasts. It is bound to THIS session — there is no token to send back, the same cookie carries it.',
      },
    },
    required: ['expiresIn'],
    additionalProperties: false,
  },
  'GET /api/dash/permissions': {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: UUID_SCHEMA,
        roleName: { type: 'string' },
        description: NULLABLE_STRING_SCHEMA,
        isActive: { type: 'boolean' },
        createdAt: DATE_TIME_SCHEMA,
        updatedAt: DATE_TIME_SCHEMA,
        usersCount: { type: 'integer', minimum: 0 },
      },
      required: [
        'id',
        'roleName',
        'description',
        'isActive',
        'createdAt',
        'updatedAt',
        'usersCount',
      ],
      additionalProperties: false,
    },
  },
  'POST /api/dash/permissions': CREATED_ID_SCHEMA,
  'GET /api/dash/permissions/:id': {
    type: 'object',
    properties: {
      id: UUID_SCHEMA,
      roleName: { type: 'string' },
      description: NULLABLE_STRING_SCHEMA,
      isActive: { type: 'boolean' },
      permissions: { type: 'array', items: PAGE_PERMISSION_SCHEMA },
    },
    required: ['id', 'roleName', 'description', 'isActive', 'permissions'],
    additionalProperties: false,
  },
  'PUT /api/dash/permissions/:id': UPDATED_AT_SCHEMA,
  'DELETE /api/dash/permissions/:id': NULL_SCHEMA,
  'GET /api/dash/roles': { type: 'array', items: ROLE_SUMMARY_SCHEMA },
  'POST /api/dash/users/me/change-email': CONTACT_CHANGE_SCHEMA,
  'POST /api/dash/users/me/change-email/verify': VERIFIED_SCHEMA,
  'POST /api/dash/users/:id/two-factor/reset': NULL_SCHEMA,
  'POST /api/dash/users/me/change-password': NULL_SCHEMA,
  'POST /api/dash/users/me/change-phone': CONTACT_CHANGE_SCHEMA,
  'POST /api/dash/users/me/change-phone/verify': VERIFIED_SCHEMA,
  'GET /api/dash/users/me/preferences': PREFERENCES_SCHEMA,
  'PUT /api/dash/users/me/preferences': UPDATED_AT_SCHEMA,
  'GET /api/dash/users': {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: UUID_SCHEMA,
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
        isActive: { type: 'boolean' },
        roleId: ROLE_ID_SCHEMA,
        createdAt: DATE_TIME_SCHEMA,
        updatedAt: DATE_TIME_SCHEMA,
        role: ROLE_SUMMARY_SCHEMA,
      },
      required: [
        'id',
        'name',
        'email',
        'isActive',
        'roleId',
        'createdAt',
        'updatedAt',
        'role',
      ],
      additionalProperties: false,
    },
  },
  'POST /api/dash/users': CREATED_ID_SCHEMA,
  'GET /api/dash/users/:id': {
    type: 'object',
    properties: {
      id: UUID_SCHEMA,
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      emailVerified: { type: 'boolean' },
      phoneNumber: NULLABLE_STRING_SCHEMA,
      phoneNumberVerified: { type: 'boolean' },
      isActive: { type: 'boolean' },
      roleId: NULLABLE_ROLE_ID_SCHEMA,
      role: NULLABLE_ROLE_SUMMARY_SCHEMA,
      createdAt: DATE_TIME_SCHEMA,
      updatedAt: DATE_TIME_SCHEMA,
      // The role's rows, as `GET /api/dash/permissions/:id` maps them — not
      // the page-keyed `USER_PERMISSION_MATRIX_SCHEMA` of session metadata.
      permissions: { type: 'array', items: PAGE_PERMISSION_SCHEMA },
      sessions: { type: 'array', items: SESSION_SUMMARY_SCHEMA },
      sessionsHasMore: { type: 'boolean' },
      sessionsNextCursor: NULLABLE_CURSOR_SCHEMA,
    },
    required: [
      'id',
      'name',
      'email',
      'emailVerified',
      'phoneNumber',
      'phoneNumberVerified',
      'isActive',
      'roleId',
      'role',
      'createdAt',
      'updatedAt',
      'permissions',
    ],
    dependentRequired: {
      sessions: ['sessionsHasMore', 'sessionsNextCursor'],
      sessionsHasMore: ['sessions', 'sessionsNextCursor'],
      sessionsNextCursor: ['sessions', 'sessionsHasMore'],
    },
    additionalProperties: false,
  },
  'PUT /api/dash/users/:id': UPDATED_AT_SCHEMA,
  'DELETE /api/dash/users/:id': NULL_SCHEMA,
  'GET /api/dash/users/:id/sessions': {
    type: 'object',
    properties: {
      sessions: { type: 'array', items: SESSION_SUMMARY_SCHEMA },
      nextCursor: NULLABLE_CURSOR_SCHEMA,
    },
    required: ['sessions', 'nextCursor'],
    additionalProperties: false,
  },
  'DELETE /api/dash/users/:id/sessions': {
    type: 'object',
    properties: {
      revoked: { type: 'array', items: UUID_SCHEMA, uniqueItems: true },
    },
    required: ['revoked'],
    additionalProperties: false,
  },
  'GET /api/dash/media': MEDIA_LIST_SCHEMA,
  'POST /api/dash/media/files': componentRef('MediaFile'),
  'DELETE /api/dash/media/files': {
    type: 'object',
    properties: {
      deleted: {
        type: 'array',
        items: UUID_SCHEMA,
        uniqueItems: true,
        description: 'Gone from the database and from the object store.',
      },
      pending: {
        type: 'array',
        items: UUID_SCHEMA,
        uniqueItems: true,
        description:
          'Committed to deletion and already gone from every listing and every media route, but the object store refused the delete or the configured cache purge failed; the nightly sweep finishes them. There is no completion signal and none is needed: these ids never come back, and no endpoint reports their progress. An edge copy is evicted only when the purge is configured; a copy already in a browser stays readable until its `Cache-Control` lifetime ends and cannot be recalled.',
      },
    },
    required: ['deleted', 'pending'],
    additionalProperties: false,
  },
  'GET /api/dash/media/files/:id': componentRef('MediaFileDetails'),
  'PUT /api/dash/media/files': {
    type: 'object',
    properties: {
      unfiledAt: { ...NULL_SCHEMA, description: 'Every moved file is filed.' },
      updatedAt: MEDIA_FILE_PROPERTIES.updatedAt,
    },
    required: ['unfiledAt', 'updatedAt'],
    additionalProperties: false,
  },
  'PUT /api/dash/media/files/:id': {
    type: 'object',
    properties: {
      displayName: {
        ...MEDIA_FILE_PROPERTIES.displayName,
        description: 'The stored, normalised name. Present when one was sent.',
      },
      unfiledAt: {
        ...NULL_SCHEMA,
        description: 'Present when a folder was sent: filing clears it.',
      },
      updatedAt: MEDIA_FILE_PROPERTIES.updatedAt,
    },
    required: ['updatedAt'],
    additionalProperties: false,
  },
  'POST /api/dash/media/files/:id/publish': componentRef('MediaFile'),
  'POST /api/dash/media/files/:id/unpublish': componentRef('MediaFile'),
  'POST /api/dash/media/folders': {
    type: 'object',
    properties: {
      id: MEDIA_FOLDER_PROPERTIES.id,
      name: {
        ...MEDIA_FOLDER_PROPERTIES.name,
        description: 'The stored, normalised name.',
      },
    },
    required: ['id', 'name'],
    additionalProperties: false,
  },
  'PUT /api/dash/media/folders/:id': {
    type: 'object',
    properties: {
      name: {
        ...MEDIA_FOLDER_PROPERTIES.name,
        description: 'The stored, normalised name. Present when one was sent.',
      },
      updatedAt: MEDIA_FOLDER_PROPERTIES.updatedAt,
    },
    required: ['updatedAt'],
    additionalProperties: false,
  },
  'DELETE /api/dash/media/folders/:id': FOLDER_DELETE_SCHEMA,
  'POST /api/upload/file': {
    type: 'array',
    items: componentRef('MediaFile'),
    minItems: 1,
    maxItems: 1,
    description:
      'One pending file. It is not listable until the record it is for is saved and claims it.',
  },
  'POST /api/dev/sign-up': CREATED_ID_SCHEMA,
};
