/**
 * `z.compile` on the contract schemas. Strict compilation must never meet an
 * async refinement or transform, and the schemas that fall back to the runtime
 * parser are a named list. The differential holds the compiled clone to the
 * plain schema on hand-written valid input and on generated input: a generated fast path that wrongly accepts, or
 * transforms valid input differently, would otherwise be trusted.
 */
import { describe, expect, test } from 'bun:test';
import type { RequestRoute } from '@app/shared/contract';
import type {
  BetterAuthResponseRoute,
  ResponseRoute,
} from '@app/shared/response-contract';

import { BINDINGS } from '@/modules';
import * as z from 'zod';

import { isRawResponse } from '@app/shared/api/endpoint';
import { REQUEST_BODIES } from '@app/shared/contract';
import { MSG_FETCHED } from '@app/shared/messages/common';
import {
  BETTER_AUTH_RESPONSES,
  errorEnvelopeSchema,
  isPaginatedRoute,
  plainErrorEnvelopeSchema,
  RESPONSE_DATA,
} from '@app/shared/response-contract';
import { isChannelEnabled } from '@app/shared/validation/otp';
import { DEFAULT_PREFERENCES } from '@app/shared/validation/preferences';

import { successSchemaOf } from '@/lib/http/binding';
import { isJsonSchema } from '@/lib/http/openapi/json-schema';
import { generateUuidV7 } from '@/lib/id';

import { compareCodeUnits } from '@/utils/text';

import {
  mediaFileWire,
  mediaFolderWire,
  PAGE_META,
  successEnvelope,
} from '../helpers/response-fixtures';

type Named = readonly [name: string, schema: z.ZodType, io: 'input' | 'output'];

const contractSchemas: Named[] = [
  ...BINDINGS.flatMap((binding): Named[] => [
    ...(binding.entry.params
      ? [[`${binding.key} params`, binding.entry.params, 'input'] as const]
      : []),
    ...(binding.entry.query
      ? [[`${binding.key} query`, binding.entry.query, 'input'] as const]
      : []),
    ...(binding.entry.body
      ? [[`${binding.key} body`, binding.entry.body, 'input'] as const]
      : []),
    [`${binding.key} success`, successSchemaOf(binding.entry), 'output'],
    ...(isRawResponse(binding.entry.response)
      ? Object.entries(binding.entry.response.refusals ?? {}).map(
          ([status, schema]): Named => [
            `${binding.key} ${status}`,
            schema,
            'output',
          ]
        )
      : []),
  ]),
  ['error envelope', errorEnvelopeSchema, 'output'],
  ['plain error envelope', plainErrorEnvelopeSchema, 'output'],
  ...Object.entries(REQUEST_BODIES).map(([key, schema]): Named => [
    `${key} request`,
    schema,
    'input',
  ]),
  ...Object.entries(RESPONSE_DATA).map(([key, schema]): Named => [
    `${key} data`,
    schema,
    'output',
  ]),
  ...Object.entries(BETTER_AUTH_RESPONSES).map(([key, schema]): Named => [
    `Better Auth ${key}`,
    schema,
    'output',
  ]),
];

/**
 * The `z.xor` schemas (exactly one branch), which the fast path cannot model:
 * they keep the runtime parser rather than loosen to a union.
 */
const RUNTIME_FALLBACKS = [
  'GET /api/dash/media data',
  'POST /api/dash/users/me/change-email data',
  'POST /api/dash/users/me/change-phone data',
  'Better Auth /oauth/google/callback',
  'Better Auth /oauth/result',
  'Better Auth /passwordless/verify',
];

describe('strict compilation', () => {
  const refusals = contractSchemas.flatMap(([name, schema]) => {
    try {
      z.compile(schema, { strict: true });
      return [];
    } catch (error) {
      return [{ name, error }];
    }
  });

  test('meets no async refinement or transform', () => {
    expect(
      refusals
        .filter(({ error }) => error instanceof z.ZodCompileAsyncError)
        .map(({ name }) => name)
    ).toEqual([]);
  });

  test('falls back to the runtime parser only for the named xor schemas', () => {
    expect(
      [
        ...new Set(
          refusals
            .filter(
              ({ error }) => error instanceof z.ZodCompileUnsupportedError
            )
            .map(({ name }) => name)
        ),
      ].toSorted(compareCodeUnits)
    ).toEqual(RUNTIME_FALLBACKS.toSorted(compareCodeUnits));
  });
});

test('no contract schema is named by id', () => {
  // A `.meta({ id })` publishes a `$defs` reference neither validator resolves.
  expect(
    contractSchemas
      .filter(([, schema, io]) =>
        JSON.stringify(
          z.toJSONSchema(schema, { io, unrepresentable: 'any' })
        ).includes('"$defs"')
      )
      .map(([name]) => name)
  ).toEqual([]);
});

/** Values a JSON Schema node admits, and a few it should not. */
function samples(node: unknown, depth = 0): unknown[] {
  if (!isJsonSchema(node) || depth > 6) return [null];
  const schema = node;
  const branches = [schema.anyOf, schema.oneOf].filter(Array.isArray).flat();
  if (branches.length > 0)
    return branches.flatMap((branch) => samples(branch, depth + 1));
  if ('const' in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;

  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  return type.flatMap((kind): unknown[] => {
    switch (kind) {
      case 'null': {
        return [null];
      }
      case 'boolean': {
        return [true, false];
      }
      case 'integer':
      case 'number': {
        const minimum = typeof schema.minimum === 'number' ? schema.minimum : 0;
        return [minimum, minimum + 1, -1, 1.5];
      }
      case 'string': {
        if (schema.format === 'uuid')
          return ['01922b8c-5d3e-7f00-8a00-000000000001'];
        if (schema.format === 'date-time') return ['2026-10-10T00:00:00.000Z'];
        if (schema.format === 'email') return ['a@gmail.com'];
        if (schema.format === 'uri') return ['https://example.com/x'];
        return ['', 'abc', '12', 'رسالة'];
      }
      case 'array': {
        const items = samples(schema.items, depth + 1);
        return [[], items.slice(0, 1), items.slice(0, 3)];
      }
      case 'object': {
        const properties = isJsonSchema(schema.properties)
          ? schema.properties
          : {};
        const full = Object.fromEntries(
          Object.entries(properties).map(([key, child]) => [
            key,
            samples(child, depth + 1)[0],
          ])
        );
        const variants: unknown[] = [full, {}, { ...full, unexpected: 1 }];
        for (const key of Object.keys(full)) {
          const { [key]: _dropped, ...without } = full;
          variants.push(
            without,
            { ...full, [key]: 7 },
            { ...full, [key]: null }
          );
        }
        return variants;
      }
      default: {
        return ['x', 1, true, null, [], {}];
      }
    }
  });
}

const issuesOf = (result: z.ZodSafeParseResult<unknown>) =>
  result.success ? null : JSON.stringify(result.error.issues);

const ID = generateUuidV7();
/** As a client may send an id: the input schemas trim and lowercase it. */
const SENT_ID = ` ${ID.toUpperCase()} `;
const EMAIL = ' Someone@Gmail.com ';
const PHONE = '٠٥١٢٣٤٥٦٧٨';
const PASSWORD = 'Valid-Pass1';
const CODE = ' 123456 ';
const NAME = ' سارة ';
const GRANT = { grant: 'grant', option: 'otp:email' };
const ACCESS = [{ name: 'users', permissions: { view: true, edit: true } }];
const SELECTION = { fileIds: [SENT_ID], folderIds: [] };
const CONTACTS = [
  { channel: 'email', email: EMAIL },
  { channel: 'sms', phoneNumber: PHONE },
  { channel: 'whatsapp', phoneNumber: 512_345_678 },
];
/** A send refuses a channel this deployment has not enabled. */
const SENDABLE = CONTACTS.filter(({ channel }) => isChannelEnabled(channel));

/** Shared by each binding's body and its `REQUEST_BODIES` entry. */
const BODIES: Record<RequestRoute, readonly unknown[]> = {
  'POST /api/auth/forgot-password/reset': CONTACTS.map((contact) => ({
    ...contact,
    code: CODE,
    newPassword: PASSWORD,
  })),
  'POST /api/auth/forgot-password/second-factor/send': [GRANT],
  'POST /api/auth/forgot-password/complete': [
    { ...GRANT, code: CODE, newPassword: PASSWORD },
    { ...GRANT, code: 'abcde-12345', newPassword: PASSWORD },
  ],
  'POST /api/auth/forgot-password/send': SENDABLE,
  'POST /api/auth/otp/send': SENDABLE,
  'POST /api/auth/otp/verify': CONTACTS.map((contact) => ({
    ...contact,
    code: CODE,
  })),
  'POST /api/auth/passwordless/send': SENDABLE,
  'POST /api/dash/auth/reauth': [{ password: PASSWORD }],
  'POST /api/dash/permissions': [
    { roleName: 'Editors', permissions: ACCESS, isActive: true },
  ],
  'PUT /api/dash/permissions/:id': [{ roleName: 'Editors', isActive: false }],
  'POST /api/dash/users': [
    { email: EMAIL, password: PASSWORD, name: NAME, roleId: SENT_ID },
    {
      email: EMAIL,
      password: PASSWORD,
      name: NAME,
      roleId: 'custom',
      permissions: ACCESS,
      phoneNumber: PHONE,
    },
  ],
  'PUT /api/dash/users/:id': [
    {
      email: EMAIL,
      name: NAME,
      isActive: true,
      roleId: SENT_ID,
      phoneNumber: null,
    },
  ],
  'PUT /api/dash/users/me': [{ name: NAME }],
  'POST /api/dash/users/me/change-email': [
    { currentPassword: PASSWORD, newEmail: EMAIL },
  ],
  'POST /api/dash/users/me/change-email/verify': [
    { newEmail: EMAIL, code: CODE },
  ],
  'POST /api/dash/users/me/change-password': [
    { currentPassword: PASSWORD, newPassword: PASSWORD },
  ],
  'POST /api/dash/users/me/change-phone': [
    { newPhoneNumber: PHONE, channel: 'whatsapp' },
  ],
  'POST /api/dash/users/me/change-phone/verify': [
    { newPhoneNumber: PHONE, channel: 'sms', code: CODE },
  ],
  'PUT /api/dash/users/me/preferences': [DEFAULT_PREFERENCES],
  'DELETE /api/dash/users/:id/sessions': [
    { sessionIds: [SENT_ID] },
    { revokeAll: true },
  ],
  'PUT /api/dash/media': [
    { ...SELECTION, to: SENT_ID },
    { fileIds: [], folderIds: [SENT_ID], to: null },
  ],
  'DELETE /api/dash/media': [{ ...SELECTION, recursive: true }],
  'POST /api/dash/media/delete-preview': [SELECTION],
  'DELETE /api/dash/media/files': [{ ids: [SENT_ID] }],
  'PUT /api/dash/media/files': [{ ids: [SENT_ID], folderId: SENT_ID }],
  'PUT /api/dash/media/files/:id': [
    { displayName: ' report.pdf ' },
    { folderId: SENT_ID },
  ],
  'POST /api/dash/media/folders': [{ name: ' Logos ', parentId: null }],
  'PUT /api/dash/media/folders/:id': [{ name: 'Logos' }, { parentId: SENT_ID }],
  'POST /api/dev/sign-up': [{ name: NAME, email: EMAIL, password: PASSWORD }],
};

const file = mediaFileWire();
const folder = mediaFolderWire();
const AT = file.createdAt;
const ROLE = { id: ID, roleName: 'Editors' };
const TOTALS = { folders: 1, files: 2, bytes: 4096 };
const UNCHANGED = { updatedAt: AT };
const DELETED_FOLDER = {
  folders: 1,
  folderIds: [ID],
  deleted: [file.id],
  pending: [],
};
const SESSION = {
  id: ID,
  ipAddress: null,
  userAgent: 'Mozilla/5.0',
  createdAt: AT,
  isCurrent: true,
};
const SECOND_FACTOR = {
  id: 'otp:email',
  method: 'otp',
  contactKind: 'email',
  channel: 'email',
};

/** Each route's `data`; its success fixture wraps them. */
const DATA: Record<ResponseRoute, readonly unknown[]> = {
  'POST /api/auth/forgot-password/reset': [
    { reset: true },
    {
      reset: false,
      twoFactorRequired: true,
      grant: 'grant',
      options: [SECOND_FACTOR],
      defaultMethod: 'otp:email',
    },
  ],
  'POST /api/auth/forgot-password/second-factor/send': [{ nextAllowedIn: 60 }],
  'POST /api/auth/forgot-password/complete': [{ reset: true }],
  'POST /api/auth/forgot-password/send': [{ nextAllowedIn: 30 }],
  'POST /api/auth/otp/send': [{ nextAllowedIn: 30 }],
  'POST /api/auth/otp/verify': [{ verified: true }],
  'POST /api/auth/passwordless/send': [{ nextAllowedIn: 30 }],
  'POST /api/dash/auth/reauth': [{ expiresIn: 300 }],
  'GET /api/dash/permissions': [
    [
      {
        ...ROLE,
        description: null,
        isActive: true,
        createdAt: AT,
        updatedAt: AT,
        usersCount: 3,
      },
    ],
  ],
  'POST /api/dash/permissions': [{ id: ID }],
  'GET /api/dash/permissions/:id': [
    {
      ...ROLE,
      description: 'Edits users',
      isActive: true,
      permissions: ACCESS,
    },
  ],
  'PUT /api/dash/permissions/:id': [UNCHANGED],
  'DELETE /api/dash/permissions/:id': [null],
  'GET /api/dash/roles': [[ROLE]],
  'PUT /api/dash/users/me': [UNCHANGED],
  'POST /api/dash/users/me/change-email': [
    { autoVerified: true },
    { otpSent: true },
  ],
  'POST /api/dash/users/me/change-email/verify': [{ verified: true }],
  'POST /api/dash/users/:id/two-factor/reset': [null],
  'POST /api/dash/users/me/change-password': [null],
  'POST /api/dash/users/me/change-phone': [
    { autoVerified: true },
    { otpSent: true },
  ],
  'POST /api/dash/users/me/change-phone/verify': [{ verified: true }],
  'GET /api/dash/users/me/preferences': [
    { preferences: DEFAULT_PREFERENCES, updatedAt: null },
    { preferences: DEFAULT_PREFERENCES, updatedAt: AT },
  ],
  'PUT /api/dash/users/me/preferences': [UNCHANGED],
  'GET /api/dash/users': [
    [
      {
        id: ID,
        name: 'Sara',
        email: 'someone@gmail.com',
        isActive: true,
        roleId: ROLE.id,
        role: ROLE,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  ],
  'POST /api/dash/users': [{ id: ID }],
  'GET /api/dash/users/:id': [
    {
      id: ID,
      name: 'Sara',
      email: 'someone@gmail.com',
      emailVerified: true,
      phoneNumber: '966512345678',
      phoneNumberVerified: false,
      isActive: true,
      roleId: 'custom',
      role: null,
      createdAt: AT,
      updatedAt: AT,
      permissions: ACCESS,
      sessions: [SESSION],
      sessionsHasMore: false,
      sessionsNextCursor: null,
    },
  ],
  'PUT /api/dash/users/:id': [UNCHANGED],
  'DELETE /api/dash/users/:id': [null],
  'GET /api/dash/users/:id/sessions': [
    { sessions: [SESSION], nextCursor: `${AT}|${ID}` },
  ],
  'DELETE /api/dash/users/:id/sessions': [{ revoked: [ID] }],
  'GET /api/dash/media': [
    {
      visibilities: ['private'],
      canPublish: false,
      files: [file],
      breadcrumbs: [{ id: folder.id, name: folder.name }],
      folders: [folder],
    },
    {
      visibilities: ['private', 'public'],
      canPublish: true,
      files: [],
      folders: [{ ...folder, breadcrumbs: [] }],
      foldersTruncated: false,
    },
    { visibilities: [], canPublish: false, files: [file], retentionDays: 7 },
  ],
  'PUT /api/dash/media': [
    { fileIds: [file.id], folderIds: [], unfiledAt: null, updatedAt: AT },
  ],
  'DELETE /api/dash/media': [DELETED_FOLDER],
  'POST /api/dash/media/delete-preview': [
    {
      ...TOTALS,
      limit: 500,
      exceedsLimit: false,
      nonEmptyFolderIds: null,
      busyFileIds: [file.id],
      inUseFileIds: null,
      unfinishedFolderIds: null,
    },
  ],
  'GET /api/dash/media/stats': [TOTALS],
  'POST /api/dash/media/files': [file],
  'DELETE /api/dash/media/files': [{ deleted: [file.id], pending: [] }],
  'GET /api/dash/media/files/:id': [
    {
      ...file,
      downloadUrl: file.url,
      previewUrl: null,
      usedBy: [
        { label: 'Avatar', resource: 'users', recordId: ID, name: 'Sara' },
      ],
      visibleUsages: 1,
      hiddenUsages: 0,
    },
  ],
  'PUT /api/dash/media/files': [{ unfiledAt: null, updatedAt: AT }],
  'PUT /api/dash/media/files/:id': [
    { displayName: file.displayName, unfiledAt: null, updatedAt: AT },
  ],
  'POST /api/dash/media/files/:id/publish': [file],
  'POST /api/dash/media/files/:id/unpublish': [file],
  'POST /api/dash/media/folders': [{ id: folder.id, name: folder.name }],
  'GET /api/dash/media/folders/:id': [
    { ...folder, breadcrumbs: [], totals: TOTALS },
  ],
  'PUT /api/dash/media/folders/:id': [{ name: folder.name, updatedAt: AT }],
  'DELETE /api/dash/media/folders/:id': [DELETED_FOLDER],
  'POST /api/upload/file': [[file]],
  'POST /api/dev/sign-up': [{ id: ID }],
};

const PASSKEY_OPTIONS = {
  data: {
    challenge: 'Y2hhbGxlbmdl',
    timeout: 60_000,
    rpId: 'example.com',
    allowCredentials: [
      { id: 'Y3JlZGVudGlhbA', type: 'public-key', transports: ['internal'] },
    ],
    userVerification: 'required',
  },
};
const TWO_FACTOR_REDIRECT = {
  twoFactorRedirect: true,
  twoFactorMethods: ['otp'],
  twoFactorOptions: [{ ...SECOND_FACTOR, nextAllowedIn: 0 }],
  defaultMethod: null,
};
const LOGGED_IN = { data: { loggedIn: true } };

const BETTER_AUTH: Record<BetterAuthResponseRoute, readonly unknown[]> = {
  '/capabilities': [{ data: { oauthProviders: ['google'] } }],
  '/reauth/methods': [{ data: { methods: ['password', 'passkey'] } }],
  '/reauth/passkey/options': [PASSKEY_OPTIONS],
  '/reauth/passkey/verify': [{ data: { expiresIn: 300 } }],
  '/oauth/google/start': [
    { data: { url: 'https://accounts.google.com/o/oauth2/v2/auth' } },
  ],
  '/oauth/google/callback': [LOGGED_IN, TWO_FACTOR_REDIRECT],
  '/oauth/result': [LOGGED_IN, TWO_FACTOR_REDIRECT],
  '/passwordless/verify': [
    { message: MSG_FETCHED, ...LOGGED_IN },
    TWO_FACTOR_REDIRECT,
  ],
  '/two-factor/totp/start': [
    { data: { totpURI: 'otpauth://totp/App:someone?secret=JBSWY3DPEHPK3PXP' } },
  ],
  '/two-factor/totp/confirm': [
    { message: MSG_FETCHED, data: { method: 'totp' } },
  ],
  '/two-factor/generate-backup-codes': [
    { data: { backupCodes: ['abcde-12345'], setId: ID } },
  ],
  '/two-factor/backup-codes/acknowledge': [{ message: MSG_FETCHED }],
  '/two-factor/methods': [
    {
      data: {
        methods: [
          {
            method: 'otp',
            channel: 'email',
            contactKind: 'email',
            isDefault: true,
          },
        ],
      },
    },
  ],
  '/two-factor/methods/disable': [
    { message: MSG_FETCHED, data: { removedMethod: 'otp:phone' } },
  ],
  '/two-factor/methods/default': [{ data: { defaultMethod: 'totp' } }],
  '/two-factor/disable': [{ message: MSG_FETCHED }],
  '/two-factor/passkey/grant': [{ data: { grant: 'a'.repeat(32) } }],
  '/two-factor/otp/send': [
    { message: MSG_FETCHED, data: { nextAllowedIn: 30 } },
  ],
  '/two-factor/otp/verify': [
    { message: MSG_FETCHED, ...LOGGED_IN },
    { message: MSG_FETCHED, data: { method: 'otp', channel: 'sms' } },
  ],
  '/two-factor/passkey/options': [PASSKEY_OPTIONS],
  '/two-factor/passkey/verify': [{ message: MSG_FETCHED, ...LOGGED_IN }],
  '/two-factor/trust-device': [{ data: { trusted: true } }],
  '/two-factor/trusted-devices': [
    {
      data: {
        devices: [
          {
            id: ID,
            userAgent: null,
            ipAddress: '203.0.113.7',
            lastUsedAt: AT,
            expiresAt: AT,
            createdAt: AT,
          },
        ],
      },
    },
  ],
  '/two-factor/trusted-devices/revoke': [{ data: { revoked: true } }],
  '/passkey/delete-passkey': [{ data: { deleted: true } }],
};

const LIST_QUERY = {
  page: '2',
  perPage: '10',
  search: 'a',
  joinOperator: 'or',
};
const HEALTH_CHECKS = {
  journalModeWal: true,
  schemaVersion: true,
  busyTimeout: true,
  synchronousNormal: true,
  postgres: true,
};
const UPLOAD = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', {
  type: 'image/png',
});

/**
 * Hand-written input each schema in the walk must accept, keyed by its name
 * there. A plain parse that refuses one fails, and so does a schema without
 * one or one without a schema.
 */
const FIXTURES = new Map<string, readonly unknown[]>([
  ...Object.entries(BODIES).flatMap(([key, valid]) => [
    [`${key} body`, valid] as const,
    [`${key} request`, valid] as const,
  ]),
  ...Object.entries(DATA).flatMap(([key, valid]) => [
    [`${key} data`, valid] as const,
    [
      `${key} success`,
      valid.map((data) =>
        successEnvelope(data, isPaginatedRoute(key) ? { meta: PAGE_META } : {})
      ),
    ] as const,
  ]),
  ...Object.entries(BETTER_AUTH).map(
    ([path, valid]) => [`Better Auth ${path}`, valid] as const
  ),
  ...BINDINGS.filter(({ entry }) => entry.path.includes('/:id')).map(
    ({ key }) => [`${key} params`, [{ id: SENT_ID }]] as const
  ),
  ['GET /api/dash/permissions query', [LIST_QUERY, {}]],
  ['GET /api/dash/users query', [LIST_QUERY]],
  [
    'GET /api/dash/media query',
    [{ ...LIST_QUERY, scope: 'folder', folder: SENT_ID }, { scope: 'unfiled' }],
  ],
  [
    'GET /api/dash/users/:id/sessions query',
    [{ limit: '20', cursor: `${AT}|${ID}` }],
  ],
  ['POST /api/dash/media/files query', [{ folder: SENT_ID }]],
  ['POST /api/dash/media/files body', [{ file: UPLOAD }]],
  ['DELETE /api/dash/media/folders/:id query', [{ recursive: 'true' }]],
  ['POST /api/upload/file query', [{ resource: 'users', purpose: 'avatar' }]],
  ['POST /api/upload/file body', [{ files: UPLOAD }]],
  ['GET /api/health/storage query', [{ deep: '1' }]],
  [
    'GET /api/health/storage success',
    [{ status: 'ok', checks: HEALTH_CHECKS }],
  ],
  ['GET /api/health/storage 401', [{ status: 'unauthorized' }]],
  [
    'GET /api/health/storage 503',
    [{ status: 'degraded', checks: HEALTH_CHECKS }, { status: 'error' }],
  ],
  [
    'GET /openapi.json success',
    [
      {
        openapi: '3.1.1',
        info: { title: 'API', version: '1' },
        servers: [],
        tags: [],
        components: {},
        paths: {},
      },
    ],
  ],
  [
    'error envelope',
    [
      { success: false, message: MSG_FETCHED, data: null },
      {
        success: false,
        message: MSG_FETCHED,
        data: { fileIds: [file.id] },
        code: 'MEDIA_IN_USE',
      },
    ],
  ],
  [
    'plain error envelope',
    [
      { success: false, message: MSG_FETCHED, data: null },
      {
        success: false,
        message: MSG_FETCHED,
        data: null,
        code: 'REAUTH_REQUIRED',
      },
    ],
  ],
]);

describe('compiled and plain parse alike', () => {
  test('every schema has a fixture, and every fixture a schema', () => {
    const names = new Set(contractSchemas.map(([name]) => name));
    expect([...names].filter((name) => !FIXTURES.get(name)?.length)).toEqual(
      []
    );
    expect(
      FIXTURES.keys()
        .filter((name) => !names.has(name))
        .toArray()
    ).toEqual([]);
  });

  test.each(
    contractSchemas.map(([name, schema, io]) => [name, schema, io] as const)
  )('%s', (name, schema, io) => {
    const compiled = z.compile(schema);
    const valid = FIXTURES.get(name) ?? [];
    expect(valid).not.toHaveLength(0);
    expect(valid.map((input) => issuesOf(schema.safeParse(input)))).toEqual(
      valid.map(() => null)
    );
    const inputs = [
      ...valid,
      ...samples(z.toJSONSchema(schema, { io, unrepresentable: 'any' })),
      undefined,
      'x',
      42,
      [],
    ];
    expect(inputs.some((input) => !schema.safeParse(input).success)).toBe(true);
    for (const input of inputs) {
      const plain = schema.safeParse(input);
      const fast = compiled.safeParse(input);
      expect(fast.success).toBe(plain.success);
      expect(JSON.stringify(fast.data)).toBe(JSON.stringify(plain.data));
      expect(issuesOf(fast)).toBe(issuesOf(plain));
    }
  });
});
