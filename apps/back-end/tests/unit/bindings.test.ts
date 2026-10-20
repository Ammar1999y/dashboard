/**
 * The bindings held to the shared entries and to their policy: the
 * security assertions the legacy route table's tests made, carried over.
 * The type-level half is in `contract-types.test.ts`.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { BINDINGS } from '@/modules';
import * as z from 'zod';

import { ENDPOINTS } from '@app/shared/api/all';
import { getPermission, listPermissions } from '@app/shared/api/permissions';
import { DATA_TABLE_PARAM_KEYS } from '@app/shared/data-table/parsers';
import { dataTableQuerySchema } from '@app/shared/data-table/query';

import { actorOf, GateSkipped } from '@/lib/http/admit';
import { bind, createdBindings } from '@/lib/http/binding';
import { isSafeMethod } from '@/lib/http/origin';
import { refusalsOf } from '@/lib/http/refusals';

import { compareCodeUnits } from '@/utils/text';

/** The success statuses the routes answered before the rewrite, frozen with the wire format. */
const CREATED_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/dash/permissions',
  'POST /api/dash/users',
  'POST /api/dash/media/files',
  'POST /api/dash/media/folders',
  'POST /api/upload/file',
  'POST /api/dev/sign-up',
]);

/**
 * The routes that need the re-authentication window, frozen: the flag is
 * shared policy, and the gate, the document and the walks all derive from it,
 * so a flag dropped there would drop the requirement with every test green.
 */
const REAUTH_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/dash/permissions',
  'PUT /api/dash/permissions/:id',
  'DELETE /api/dash/permissions/:id',
  'POST /api/dash/users',
  'PUT /api/dash/users/:id',
  'DELETE /api/dash/users/:id',
  'POST /api/dash/users/:id/two-factor/reset',
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-password',
  'POST /api/dash/users/me/change-phone',
]);

/** The routes behind a captcha, frozen for the same reason. */
const CAPTCHA_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/auth/otp/send',
  'POST /api/auth/otp/verify',
  'POST /api/auth/passwordless/send',
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/forgot-password/reset',
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-email/verify',
  'POST /api/dash/users/me/change-password',
  'POST /api/dash/users/me/change-phone',
  'POST /api/dash/users/me/change-phone/verify',
]);

// Every module, not only those `BINDINGS` imports, and before any test
// below binds a synthetic entry of its own.
const ROOT = path.join(import.meta.dir, '..', '..');
const MODULES = new Glob('modules/**/*.ts').scanSync(ROOT);
for (const file of MODULES)
  // eslint-disable-next-line no-unsanitized/method -- a module the glob above found in this repository
  await import(path.join(ROOT, file));
const CREATED = createdBindings();

const cases = BINDINGS.map((binding) => [binding.key, binding] as const);
const statusesOf = (binding: (typeof BINDINGS)[number]) =>
  refusalsOf(binding).map((refusal) => refusal.status);

test('the walks below are not empty', () => {
  expect(BINDINGS.length).toBeGreaterThan(4);
});

test('every frozen route is bound', () => {
  const keys = new Set(BINDINGS.map(({ key }) => key));
  expect(
    [...CREATED_ROUTES, ...REAUTH_ROUTES, ...CAPTCHA_ROUTES].filter(
      (key) => !keys.has(key)
    )
  ).toEqual([]);
});

test('every binding a module creates is registered', () => {
  const registered = new Set<unknown>(BINDINGS);
  const created = new Set<unknown>(CREATED);
  expect(
    CREATED.filter((binding) => !registered.has(binding)).map(({ key }) => key)
  ).toEqual([]);
  expect(
    BINDINGS.filter((binding) => !created.has(binding)).map(({ key }) => key)
  ).toEqual([]);
});

test('binds every shared entry, each once', () => {
  const bound = BINDINGS.map(({ entry }) => entry);
  expect(ENDPOINTS.filter((entry) => !bound.includes(entry))).toEqual([]);
  expect(new Set(bound).size).toBe(bound.length);
  expect(bound.length).toBe(ENDPOINTS.length);
});

describe.each(cases)('%s', (key, binding) => {
  const { entry, options } = binding;

  test('declares the success status the legacy route answered', () => {
    expect(entry.status).toBe(CREATED_ROUTES.has(key) ? 201 : 200);
  });

  test('asks for the re-authentication window exactly where the frozen list says', () => {
    expect(entry.policy.reauth).toBe(REAUTH_ROUTES.has(key));
  });

  test('asks for a captcha exactly where the frozen list says', () => {
    expect(entry.policy.captcha).toBe(CAPTCHA_ROUTES.has(key));
  });

  test('is not public under /api/dash', () => {
    if (entry.path.startsWith('/api/dash/') || entry.path === '/openapi.json')
      expect(entry.policy.auth).not.toBe('public');
  });

  test('names a permission exactly when its policy asks for one', () => {
    expect(options.permission !== undefined).toBe(
      entry.policy.auth === 'permission'
    );
  });

  test('carries a limiter exactly when its policy is rate-limited, and publishes it', () => {
    expect(options.rateLimit !== undefined).toBe(entry.policy.rateLimited);
    if (entry.policy.rateLimited || options.preAuthIpLimit !== false)
      expect(statusesOf(binding)).toContain(429);
  });

  test('publishes the refusals its policy implies', () => {
    const statuses = statusesOf(binding);
    if (entry.policy.auth !== 'public' || entry.policy.reauth)
      expect(statuses).toContain(401);
    if (
      entry.policy.auth === 'permission' ||
      entry.policy.captcha ||
      !isSafeMethod(entry.method)
    )
      expect(statuses).toContain(403);
    expect(statuses).toContain(500);
    expect(statuses).toContain(503);
    expect(statuses).not.toContain(entry.status);
  });

  test('re-authentication is asked only by an authenticated route', () => {
    if (entry.policy.reauth) expect(entry.policy.auth).not.toBe('public');
  });

  test('a JSON or multipart body has a schema', () => {
    expect(entry.bodyKind !== 'none').toBe(entry.body !== undefined);
  });

  test('leaves its limiter to the handler only on an upload, after the checks the gate cannot make', () => {
    expect(options.rateLimit?.deferred === true).toBe(
      entry.bodyKind === 'multipart'
    );
  });

  test('publishes a narrower body only as a subset of the branches it validates', () => {
    const published = options.detail.publishedBody;
    if (published === undefined) return;
    if (
      !(published instanceof z.ZodUnion) ||
      !(entry.body instanceof z.ZodUnion)
    )
      throw new Error(`${key} narrows a body that is not a union`);
    const validated: readonly unknown[] = entry.body.options;
    expect(published.options.length).toBeGreaterThan(0);
    for (const option of published.options) expect(validated).toContain(option);
  });

  test('exempts the caller from the grant only on a route about one user', () => {
    const self = options.permission?.orSelf;
    if (self === true) expect(entry.path).toStartWith('/api/dash/users/me');
    else if (self !== undefined) {
      expect(entry.path).toStartWith('/api/dash/users/:id');
      expect(self).toBe('id');
    }
  });

  test('refuses the caller as its own target exactly on the administrative user edit', () => {
    expect(options.permission?.notSelf).toBe(
      key === 'PUT /api/dash/users/:id' ? 'id' : undefined
    );
  });

  test('leaves the re-authentication window to the handler exactly on the administrative user edit, whose window depends on the change', () => {
    expect(options.permission?.handlerAsksReauth === true).toBe(
      key === 'PUT /api/dash/users/:id'
    );
  });
});

test('captcha is the gate’s alone: no binding module verifies one itself', async () => {
  // A Turnstile token is single-use, so a second verification in a handler
  // would refuse every request the gate admitted.
  const files = Iterator.from(
    new Glob('modules/**/*.ts').scanSync(path.join(import.meta.dir, '..', '..'))
  ).toArray();
  expect(files.length).toBeGreaterThan(2);
  for (const file of files)
    expect(
      await Bun.file(path.join(import.meta.dir, '..', '..', file)).text(),
      file
    ).not.toContain('verifyTurnstileRequest');
  expect(BINDINGS.some(({ entry }) => entry.policy.captcha)).toBe(true);
});

describe('bind refuses a binding its policy contradicts', () => {
  const detail = { summary: 'x', tags: ['Permissions'] } as const;
  const handler = async () => ({ message: 'x', data: [], meta: {} });

  // Each call goes around the types the way only a cast can; the boot check is
  // what stops it.
  test.each([
    [
      'no permission on a permission route',
      { rateLimit: { scope: 's', limit: 1, by: 'user' } },
    ],
    [
      'no limiter on a rate-limited route',
      { permission: { resource: 'permissions', action: 'view' } },
    ],
    [
      'a JSON ceiling on a bodyless route',
      {
        permission: { resource: 'permissions', action: 'view' },
        rateLimit: { scope: 's', limit: 1, by: 'user' },
        maxJsonBodyBytes: 10,
      },
    ],
    [
      'a self exemption naming no path parameter',
      {
        permission: { resource: 'permissions', action: 'view', orSelf: 'id' },
        rateLimit: { scope: 's', limit: 1, by: 'user' },
      },
    ],
    [
      'a self refusal naming no path parameter',
      {
        permission: { resource: 'permissions', action: 'view', notSelf: 'id' },
        rateLimit: { scope: 's', limit: 1, by: 'user' },
      },
    ],
    [
      'a handler-asked window on a route whose policy asks none',
      {
        permission: {
          resource: 'permissions',
          action: 'view',
          handlerAsksReauth: true,
        },
        rateLimit: { scope: 's', limit: 1, by: 'user' },
      },
    ],
  ])('%s', (_label, extra) => {
    expect(() =>
      bind(listPermissions, {
        failure: 'x',
        detail,
        handler,
        ...extra,
      } as never)
    ).toThrow(`${listPermissions.method} ${listPermissions.path} needs`);
  });

  test('the caller both exempted and refused as its own target', () => {
    expect(() =>
      bind(getPermission, {
        failure: 'x',
        detail,
        handler,
        permission: {
          resource: 'permissions',
          action: 'view',
          orSelf: 'id',
          notSelf: 'id',
        },
        rateLimit: { scope: 's', limit: 1, by: 'user' },
      } as never)
    ).toThrow(`${getPermission.method} ${getPermission.path} needs`);
  });

  describe('a refusal override for a part the entry does not validate', () => {
    const granted = {
      failure: 'x',
      detail,
      handler,
      permission: { resource: 'permissions', action: 'view' },
      rateLimit: { scope: 's', limit: 1, by: 'user' },
    } as const;
    const refusal = { status: 404, message: 'x' };

    test.each([
      ['params, on a route without them', listPermissions, 'params'],
      ['body, on a bodyless route', listPermissions, 'body'],
      [
        'an unreadable body, on a bodyless route',
        listPermissions,
        'unreadableBody',
      ],
      ['query, on a route without one', getPermission, 'query'],
    ] as const)('%s', (_label, entry, part) => {
      expect(() =>
        bind(entry, { ...granted, refusals: { [part]: refusal } } as never)
      ).toThrow(
        `${entry.method} ${entry.path} needs a refusal override only for a part it validates.`
      );
    });

    test.each([
      [listPermissions, 'query'],
      [getPermission, 'params'],
    ] as const)('binds one for a part %#', (entry, part) => {
      expect(() =>
        bind(entry, { ...granted, refusals: { [part]: refusal } } as never)
      ).not.toThrow();
    });
  });
});

describe('the gate', () => {
  test('a request that skipped it has no actor: the handler is refused', () => {
    expect(() => actorOf(new Request('http://localhost/x'))).toThrow(
      GateSkipped
    );
  });
});

test('the data-table query schema accepts exactly the keys its parser reads', () => {
  expect(
    Object.keys(dataTableQuerySchema.shape).toSorted(compareCodeUnits)
  ).toEqual([...DATA_TABLE_PARAM_KEYS, 'search'].toSorted(compareCodeUnits));
  // Strings only, digits for the counts: never a coerced number.
  expect(dataTableQuerySchema.safeParse({ page: '0x10' }).success).toBe(false);
  expect(dataTableQuerySchema.safeParse({ page: '' }).success).toBe(false);
  expect(dataTableQuerySchema.safeParse({ page: '12' }).data).toEqual({
    page: '12',
  });
  expect(z.toJSONSchema(dataTableQuerySchema).additionalProperties).toBe(false);
});

test('the media routes that call R2 in the request keep their idle timeout, and the shutdown drain covers it', async () => {
  const timed = BINDINGS.filter(
    ({ options }) => options.timeoutSeconds !== undefined
  ).map(({ key, options }) => `${key} ${options.timeoutSeconds}`);
  expect(timed.toSorted(compareCodeUnits)).toEqual(
    [
      'DELETE /api/dash/media 120',
      'DELETE /api/dash/media/files 120',
      'DELETE /api/dash/media/folders/:id 120',
      'POST /api/dash/media/files 120',
      'POST /api/dash/media/files/:id/publish 120',
      'POST /api/dash/media/files/:id/unpublish 120',
      'POST /api/upload/file 120',
    ].toSorted(compareCodeUnits)
  );
  const { MAX_ROUTE_TIMEOUT_SECONDS } = await import('@/app');
  expect(MAX_ROUTE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(120);
});
