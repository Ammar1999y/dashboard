/**
 * The binding pipeline on an application built over synthetic public
 * bindings, so no database or limiter is involved: what Elysia's response
 * schemas do to an answer, refusal overrides, error mapping, the exit step's
 * cookies and headers, HEAD, the timing floor, and a multipart binding's lazy form and deferred limiter.
 *
 * The response-contract check runs in its development mode here (logged, not
 * answered 500): with it enforced, an undeclared field never reaches the
 * framework's schema, which is the layer under test.
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { createApp as CreateApp } from '@/app';
import type { AnyBinding } from '@/lib/http/binding';

import { InvalidCookie, ParseError } from 'elysia';
import * as z from 'zod';

import { endpoint } from '@app/shared/api/endpoint';
import { PROBLEM_MEDIA_TYPE, problemBody } from '@app/shared/api/wire';
import { CustomError } from '@app/shared/error-class';
import {
  INVALID_RESPONSE_CODE,
  REAUTH_REQUIRED_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_NOT_FOUND,
  MSG_PAGE_NOT_FOUND,
} from '@app/shared/messages/common';
import { MSG_UNRECOGNIZED_KEYS } from '@app/shared/messages/validation';
import { createdIdSchema } from '@app/shared/responses/common';
import { permissionDetailSchema } from '@app/shared/responses/permissions';
import { idSchema, issueCodeMessage } from '@app/shared/validation/rules';

import { bind } from '@/lib/http/binding';
import { queueResponseCookies } from '@/lib/http/cookies';
import { MAX_JSON_BODY_BYTES } from '@/lib/http/request';
import { apiError } from '@/lib/http/response';
import { SECURITY_HEADERS } from '@/lib/http/security-headers';
import { MINIMUM_RESPONSE_MS } from '@/lib/http/timing-floor';
import { generateUuidV7 } from '@/lib/id';

import { compareCodeUnits } from '@/utils/text';

import { expectError } from '../helpers/expect-body';

delete process.env.RESPONSE_CONTRACT_CHECK;

const PUBLIC = {
  auth: 'public',
  captcha: false,
  reauth: false,
  rateLimited: false,
  checksPassword: false,
} as const;
const detail = { summary: 'synthetic', tags: ['Permissions'] } as const;
const SHORT = 'الاسم قصير';
const id = () => generateUuidV7();

/** `POST /api/dash/permissions`'s key, with a public policy and a small body. */
const created = endpoint({
  method: 'POST',
  path: '/api/dash/permissions',
  query: z.strictObject({}),
  body: z.object({ name: z.string().min(2, SHORT) }),
  status: 201,
  response: createdIdSchema,
  policy: PUBLIC,
});

const detailEntry = endpoint({
  method: 'GET',
  path: '/api/dash/permissions/:id',
  params: z.object({ id: idSchema }),
  status: 200,
  response: permissionDetailSchema,
  errors: { 404: {} },
  policy: PUBLIC,
});

const role = (roleId: string) => ({
  id: roleId,
  roleName: 'r',
  description: null,
  isActive: true,
  permissions: [],
});

type Mode =
  'extra' | 'invalid' | 'throw' | 'unknown' | 'cookies' | 'headers' | 'ok';
/** What the synthetic handlers do on the next request. */
const control: { mode: Mode } = { mode: 'ok' };

const bindings: AnyBinding[] = [
  bind(created, {
    failure: 'فشل الإنشاء',
    preAuthIpLimit: false,
    refusals: { query: { status: 404, message: MSG_NOT_FOUND } },
    detail,
    mapError: (error) =>
      error instanceof RangeError
        ? apiError({ message: 'mapped', status: 409 })
        : undefined,
    handler: async ({ body, meta }) => {
      if (control.mode === 'throw')
        throw new RangeError('mapped by the binding');
      if (control.mode === 'unknown') throw new Error('internal detail');
      if (control.mode === 'cookies') {
        queueResponseCookies(meta.headers, [
          { name: 'session', value: 'queued' },
          { name: 'cache', value: 'queued' },
        ]);
        return {
          message: body.name,
          data: { id: id() },
          cookies: [{ name: 'session', value: 'own' }],
        };
      }
      const data = { id: id() };
      // Wrong on purpose, past the types, as a server bug would be.
      if (control.mode === 'extra')
        return {
          message: body.name,
          data: { ...data, secret: 'LEAK' } as typeof data,
        };
      if (control.mode === 'invalid')
        return {
          message: body.name,
          data: { id: 1 } as unknown as typeof data,
        };
      return { message: body.name, data };
    },
  }),
  bind(detailEntry, {
    failure: MSG_INTERNAL_ERROR,
    preAuthIpLimit: false,
    refusals: { params: { status: 404, message: MSG_NOT_FOUND } },
    detail,
    handler: async ({ params }) => {
      if (control.mode === 'cookies') {
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      // A success that fails its schema, carrying what only a success may.
      if (control.mode === 'headers')
        return {
          message: 'ok',
          data: { id: 1 } as unknown as ReturnType<typeof role>,
          headers: { 'x-handler': 'set', 'cache-control': 'public' },
          cookies: [{ name: 'own', value: 'success' }],
        };
      return {
        message: 'ok',
        data:
          control.mode === 'extra'
            ? ({ ...role(params.id), secret: 'LEAK' } as ReturnType<
                typeof role
              >)
            : role(params.id),
      };
    },
  }),
];

const state: { app: ReturnType<typeof CreateApp> | null } = { app: null };
const handle = (path: string, init: RequestInit = {}) => {
  if (!state.app) throw new Error('not built');
  return state.app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    })
  );
};
const post = (body: unknown, query = '') =>
  handle(`/api/dash/permissions${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const { createApp } = await import('@/app');
  state.app = createApp({ bindings, prefixes: [] });
});

describe('the declared success', () => {
  test('is answered under its status, stripped of undeclared fields', async () => {
    control.mode = 'extra';
    const response = await post({ name: 'ab' });
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ message: 'ab' });
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('data.secret');
  });

  test('that fails its schema is a logged 500 naming paths and codes, never values', async () => {
    control.mode = 'invalid';
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const response = await post({ name: 'ab' });
    const lines = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();

    const problem = await expectError(
      response,
      HTTP_STATUS.INTERNAL_ERROR,
      MSG_INTERNAL_ERROR
    );
    expect(problem.code).toBe(INVALID_RESPONSE_CODE);
    const failure = lines.find((line) =>
      line.includes('response.validation.failed')
    );
    expect(failure).toContain('data.id: invalid_type');
    expect(failure).not.toContain('"id":1');
  });

  test('carries the security headers and the default cache policy', async () => {
    control.mode = 'ok';
    const response = await post({ name: 'ab' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('refusals', () => {
  test('an invalid body is 422 with the first issue’s own message', async () => {
    await expectError(await post({ name: 'a' }), 422, SHORT);
  });

  test('a body that is not an object is 400', async () => {
    await expectError(await post([1]), 400, MSG_INVALID_INPUT);
  });

  test('a part with an override answers it, and only that part', async () => {
    await expectError(
      await handle('/api/dash/permissions/nope'),
      404,
      MSG_NOT_FOUND
    );
    await expectError(
      await post({ name: 'ab' }, '?a=1&a=2'),
      404,
      MSG_NOT_FOUND
    );
  });

  test('a binding that declares no query ignores it, a repeated key included', async () => {
    control.mode = 'ok';
    const response = await handle(`/api/dash/permissions/${id()}?a=1&a=2`);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  test('a throw the binding maps is its answer', async () => {
    control.mode = 'throw';
    const response = await post({ name: 'ab' });
    expect(await expectError(response, 409, 'mapped')).toEqual(
      problemBody(409, 'mapped')
    );
  });

  test('an unexpected throw is a 500 with the binding’s failure message, never the error’s', async () => {
    control.mode = 'unknown';
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const response = await post({ name: 'ab' });
    logged.mockRestore();
    const { detail } = await expectError(response, 500);
    expect(detail).toBe('فشل الإنشاء');
  });

  test('a refusal carries the security headers', async () => {
    const response = await post({ name: 'a' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      expect(response.headers.get(name)).toBe(value);
  });
});

describe('every refusal is a problem, whoever raises it', () => {
  test('a binding’s own refusal', async () => {
    control.mode = 'cookies';
    const response = await handle(`/api/dash/permissions/${id()}`);
    expect(await expectError(response, 404, MSG_NOT_FOUND)).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: MSG_NOT_FOUND,
    });
  });

  test('a validation failure, carrying no member beyond the problem’s', async () => {
    const response = await post({ name: 'a' });
    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: SHORT,
    });
  });

  test('a refusal override keeps its status and message in the problem', async () => {
    const problem = await expectError(
      await post({ name: 'ab' }, '?a=1&a=2'),
      404,
      MSG_NOT_FOUND
    );
    expect(problem.title).toBe('Not Found');
  });

  test('a body Elysia cannot parse', async () => {
    const problem = await expectError(
      await handle('/api/dash/permissions', { method: 'POST', body: '{' }),
      400,
      MSG_INVALID_INPUT
    );
    expect(problem.title).toBe('Bad Request');
  });

  test('a route miss', async () => {
    const problem = await expectError(
      await handle('/api/dash/nothing-here'),
      404,
      MSG_PAGE_NOT_FOUND
    );
    expect(problem.title).toBe('Not Found');
  });

  test('a wrong method keeps its Allow header', async () => {
    const response = await handle('/api/dash/permissions', { method: 'PUT' });
    const problem = await expectError(response, 405);
    expect(problem.title).toBe('Method Not Allowed');
    expect(response.headers.get('allow')).toContain('POST');
  });

  test('the request hook’s declared-length refusal', async () => {
    const response = await handle('/api/dash/permissions', {
      method: 'POST',
      headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
      body: JSON.stringify({ name: 'ab' }),
    });
    const problem = await expectError(response, HTTP_STATUS.CONTENT_TOO_LARGE);
    expect(problem.title).toBe('Content Too Large');
  });
});

describe('queued cookies', () => {
  test('ride a success, the answer’s own cookie winning a name clash', async () => {
    control.mode = 'cookies';
    const response = await post({ name: 'ab' });
    expect(response.headers.getSetCookie().toSorted(compareCodeUnits)).toEqual([
      'cache=queued',
      'session=own',
    ]);
  });

  test('ride a refusal too', async () => {
    control.mode = 'cookies';
    const request = new Request(
      `http://localhost/api/dash/permissions/${id()}`
    );
    queueResponseCookies(request.headers, [{ name: 'expired', value: '' }]);
    if (!state.app) throw new Error('not built');
    const response = await state.app.handle(request);
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual(['expired=']);
  });

  test('all ride the 500 of a success its schema refuses, even one the success’s own cookie displaced', async () => {
    control.mode = 'headers';
    const request = new Request(
      `http://localhost/api/dash/permissions/${id()}`
    );
    queueResponseCookies(request.headers, [
      { name: 'own', value: 'queued' },
      { name: 'queued', value: '1' },
    ]);
    if (!state.app) throw new Error('not built');
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const response = await state.app.handle(request);
    logged.mockRestore();
    expect(response.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(response.headers.getSetCookie().toSorted(compareCodeUnits)).toEqual([
      'own=queued',
      'queued=1',
    ]);
  });
});

describe('HEAD on a GET binding', () => {
  test('answers the stripped GET’s length and headers, with no body', async () => {
    control.mode = 'extra';
    const target = `/api/dash/permissions/${id()}`;
    const get = await handle(target);
    const head = await handle(target, { method: 'HEAD' });
    const { byteLength: length } = await get.arrayBuffer();

    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(length));
    expect(head.headers.get('content-type')).toBe(
      get.headers.get('content-type')
    );
  });

  test('a success failing its schema is the GET’s 500, which keeps none of the success’s headers or cookies', async () => {
    control.mode = 'headers';
    const target = `http://localhost/api/dash/permissions/${id()}`;
    const send = (method: string) => {
      const request = new Request(target, { method });
      queueResponseCookies(request.headers, [{ name: 'queued', value: '1' }]);
      if (!state.app) throw new Error('not built');
      return state.app.handle(request);
    };
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const get = await send('GET');
    const head = await send('HEAD');
    logged.mockRestore();
    const { byteLength: length } = await get.clone().arrayBuffer();

    const problem = await expectError(
      get.clone(),
      HTTP_STATUS.INTERNAL_ERROR,
      MSG_INTERNAL_ERROR
    );
    expect(problem.code).toBe(INVALID_RESPONSE_CODE);
    expect(get.headers.get('x-handler')).toBeNull();
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(get.headers.getSetCookie()).toEqual(['queued=1']);
    expect(head.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(length));
    const comparable = (response: Response) =>
      response.headers
        .entries()
        .filter(([name]) => name !== 'content-length')
        .toArray();
    expect(comparable(head)).toEqual(comparable(get));
  });
});

describe('the timing floor', () => {
  const floored = endpoint({
    method: 'POST',
    path: '/api/auth/otp/send',
    body: z.object({ known: z.boolean() }),
    status: 200,
    response: z.object({ nextAllowedIn: z.number() }),
    policy: PUBLIC,
  });

  test('holds a refusal raised after `startFloor` until the floor, and nothing before it', async () => {
    const { createApp } = await import('@/app');
    const app = createApp({
      bindings: [
        bind(floored, {
          failure: MSG_INTERNAL_ERROR,
          preAuthIpLimit: false,
          timingFloor: true,
          detail,
          handler: async ({ body, meta }) => {
            if (!body.known) throw new CustomError(MSG_INVALID_INPUT, 400);
            meta.startFloor();
            throw new CustomError(MSG_NOT_FOUND, 404);
          },
        }),
      ],
      prefixes: [],
    });
    const send = (known: boolean) =>
      app.handle(
        new Request('http://localhost/api/auth/otp/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ known }),
        })
      );

    const unfloored = performance.now();
    const refused = await send(false);
    expect(refused.status).toBe(400);
    expect(performance.now() - unfloored).toBeLessThan(MINIMUM_RESPONSE_MS / 2);

    const started = performance.now();
    const held = await send(true);
    expect(held.status).toBe(404);
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      MINIMUM_RESPONSE_MS - 5
    );
  }, 10_000);
});

describe('a multipart binding with a deferred limiter', () => {
  const uploaded = endpoint({
    method: 'POST',
    path: '/api/upload/file',
    query: z.strictObject({ field: z.string() }),
    body: z.object({ file: z.file() }),
    bodyKind: 'multipart',
    status: 201,
    response: z.object({ fields: z.array(z.string()) }),
    policy: { ...PUBLIC, rateLimited: true },
  });
  const seen: { unread?: boolean; fields?: string[]; reads: number } = {
    reads: 0,
  };

  const build = async () => {
    const { createApp } = await import('@/app');
    return createApp({
      bindings: [
        bind(uploaded, {
          failure: 'فشل الرفع',
          preAuthIpLimit: false,
          rateLimit: { scope: 'synthetic', limit: 1, by: 'ip', deferred: true },
          detail,
          handler: async ({ meta }) => {
            seen.unread = !meta.rawRequest.bodyUsed;
            const form = await meta.readFormData();
            await meta.readFormData();
            const fields = form ? Iterator.from(form.keys()).toArray() : [];
            seen.fields = fields;
            return { message: 'x', data: { fields } };
          },
        }),
      ],
      prefixes: [],
    });
  };
  const formRequest = (query: string) => {
    const form = new FormData();
    form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const request = new Request(`http://localhost/api/upload/file${query}`, {
      method: 'POST',
      body: form,
    });
    const formData = request.formData.bind(request);
    Object.defineProperty(request, 'formData', {
      value: () => {
        seen.reads += 1;
        return formData();
      },
    });
    return request;
  };

  test('reaches its handler unread, and the lazy reader parses it once', async () => {
    const app = await build();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    await app.handle(formRequest('?field=x'));
    logged.mockRestore();
    expect(seen).toEqual({ unread: true, fields: ['file'], reads: 1 });
  });

  test('a refused query leaves the body unread', async () => {
    const app = await build();
    const request = formRequest('?other=x');
    await expectError(await app.handle(request), 422);
    expect(request.bodyUsed).toBe(false);
  });

  test('a success whose handler never charged the limiter is a 500, never an unmetered answer', async () => {
    const app = await build();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.handle(formRequest('?field=x'));
    logged.mockRestore();
    const { detail } = await expectError(response, 500);
    expect(detail).toBe('فشل الرفع');
  });
});

describe('the statuses and codes a refusal carries, in development', () => {
  const coded = endpoint({
    method: 'POST',
    path: '/api/dash/permissions',
    status: 201,
    response: createdIdSchema,
    errors: { 401: {}, 404: { codes: ['DECLARED'] } },
    policy: { ...PUBLIC, reauth: true },
  });
  const thrown: { status: number; code?: string } = { status: 404 };
  const build = async () => {
    const { createApp } = await import('@/app');
    return createApp({
      bindings: [
        bind(coded, {
          failure: MSG_INTERNAL_ERROR,
          preAuthIpLimit: false,
          detail,
          handler: async () => {
            throw new CustomError('refused', thrown.status, thrown.code);
          },
        }),
      ],
      prefixes: [],
    });
  };
  const answer = async (status: number, code?: string) => {
    thrown.status = status;
    thrown.code = code;
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const app = await build();
    const response = await app.handle(
      new Request('http://localhost/api/dash/permissions', { method: 'POST' })
    );
    const lines = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();
    return { response, lines };
  };

  const mismatchLogged = (lines: readonly string[]) =>
    lines.some((line) => line.includes('response.contract.mismatch'));

  test('a declared code passes at the status that declares it', async () => {
    const { response, lines } = await answer(404, 'DECLARED');
    const body = await expectError(response, 404);
    expect(body.code).toBe('DECLARED');
    expect(mismatchLogged(lines)).toBe(false);
  });

  test('a code the policy implies passes: REAUTH_REQUIRED on a re-authenticating route', async () => {
    const { response, lines } = await answer(401, REAUTH_REQUIRED_CODE);
    const body = await expectError(response, 401);
    expect(body.code).toBe(REAUTH_REQUIRED_CODE);
    expect(mismatchLogged(lines)).toBe(false);
  });

  // Under the runner the same answers are a recorded 500 (`response-check.test.ts`).
  test.each([
    ['an undeclared code', 404, 'UNDECLARED'],
    ['a declared code at another status', 409, 'DECLARED'],
    ['an unpublished status', 409, undefined],
    ['an undeclared business 400', 400, undefined],
  ] as const)(
    '%s is logged and answered as raised',
    async (_name, status, code) => {
      const { response, lines } = await answer(status, code);
      const body = await expectError(response, status);
      expect(body.code).toBe(code);
      expect(mismatchLogged(lines)).toBe(true);
    }
  );
});

describe('a raw binding', () => {
  const raw = endpoint({
    method: 'GET',
    path: '/api/health/storage',
    status: 200,
    response: {
      raw: z.object({ status: z.literal('ok') }),
      refusals: { 401: z.object({ status: z.literal('unauthorized') }) },
    },
    policy: PUBLIC,
  });
  const next: { answer: 'ok' | 'refused' | 'extra' | 'wrong' } = {
    answer: 'ok',
  };
  const build = async () => {
    const { createApp } = await import('@/app');
    return createApp({
      bindings: [
        bind(raw, {
          failure: MSG_INTERNAL_ERROR,
          preAuthIpLimit: false,
          detail,
          handler: async () => {
            if (next.answer === 'ok') return { raw: { status: 'ok' as const } };
            if (next.answer === 'refused')
              return {
                raw: { status: 'unauthorized' as const },
                status: 401 as const,
              };
            // Wrong on purpose, past the types, as a server bug would be.
            if (next.answer === 'extra')
              return {
                raw: { status: 'unauthorized' as const, secret: 'LEAK' },
                status: 401 as const,
              };
            return {
              raw: { status: 'ok' } as unknown as { status: 'unauthorized' },
              status: 401 as const,
            };
          },
        }),
      ],
      prefixes: [],
    });
  };
  const get = async (method = 'GET') => {
    const app = await build();
    return app.handle(
      new Request('http://localhost/api/health/storage', { method })
    );
  };

  test('answers its success and its declared refusal without the envelope', async () => {
    next.answer = 'ok';
    const ok = await get();
    expect([ok.status, await ok.json()]).toEqual([200, { status: 'ok' }]);
    next.answer = 'refused';
    const refused = await get();
    expect([refused.status, await refused.json()]).toEqual([
      401,
      { status: 'unauthorized' },
    ]);
  });

  test('a refusal body that fails its own schema is a 500, as a success would be', async () => {
    next.answer = 'wrong';
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const response = await get();
    logged.mockRestore();
    await expectError(response, 500, MSG_INTERNAL_ERROR);
  });

  test.each(['extra', 'wrong'] as const)(
    'HEAD answers a %s refusal body as GET does: same status, the stripped length',
    async (answer) => {
      next.answer = answer;
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      const response = await get();
      const head = await get('HEAD');
      logged.mockRestore();
      const body = await response.text();

      if (answer === 'extra')
        expect([response.status, body]).toEqual([
          401,
          JSON.stringify({ status: 'unauthorized' }),
        ]);
      else expect(response.status).toBe(500);
      expect(head.status).toBe(response.status);
      expect(await head.text()).toBe('');
      expect(head.headers.get('content-length')).toBe(
        String(new TextEncoder().encode(body).byteLength)
      );
    }
  );
});

describe('issues Elysia scoped past its 8 KiB echo limit', () => {
  const strict = endpoint({
    method: 'POST',
    path: '/api/dash/permissions',
    query: z.strictObject({ page: z.string().optional() }),
    body: z.strictObject({ name: z.string().optional() }),
    status: 201,
    response: createdIdSchema,
    policy: PUBLIC,
  });
  const QUERY_REFUSED = 'استعلام مرفوض';
  const BODY_REFUSED = 'جسم مرفوض';
  const build = async (overrides: boolean) => {
    const { createApp } = await import('@/app');
    return createApp({
      bindings: [
        bind(strict, {
          failure: MSG_INTERNAL_ERROR,
          preAuthIpLimit: false,
          detail,
          ...(overrides && {
            refusals: {
              query: { status: 400, unauthored: QUERY_REFUSED },
              body: { status: 422, message: BODY_REFUSED },
            },
          }),
          handler: async () => ({ message: 'ok', data: { id: id() } }),
        }),
      ],
      prefixes: [],
    });
  };
  const apps: Partial<
    Record<'plain' | 'overridden', ReturnType<typeof CreateApp>>
  > = {};
  beforeAll(async () => {
    apps.plain = await build(false);
    apps.overridden = await build(true);
  });

  const HUGE_KEY = 'k'.repeat(9000);
  // Small keys whose list alone passes the budget.
  const MANY_KEYS = Array.from({ length: 700 }, (_, i) => `unknown_key_${i}`);
  const UNNAMED = issueCodeMessage('unrecognized_keys', []);

  const send = async (
    which: 'plain' | 'overridden',
    nodeEnv: string,
    { query = '', body = {} }: { query?: string; body?: unknown }
  ) => {
    const app = apps[which];
    if (!app) throw new Error('not built');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    const logged = spyOn(console, 'error');
    try {
      const response = await app.handle(
        new Request(`http://localhost/api/dash/permissions${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
      expect(logged).not.toHaveBeenCalled();
      return response;
    } finally {
      logged.mockRestore();
      process.env.NODE_ENV = previous;
    }
  };

  const cases = [
    ['one huge key', [HUGE_KEY]],
    ['many small keys', MANY_KEYS],
  ] as const;

  describe.each(['development', 'production'])('NODE_ENV=%s', (nodeEnv) => {
    test.each(cases)(
      'a strict body with %s is the 422 naming no key, never a 500',
      async (_label, keys) => {
        const body = Object.fromEntries(keys.map((key) => [key, 1]));
        await expectError(
          await send('plain', nodeEnv, { body }),
          HTTP_STATUS.UNPROCESSABLE,
          UNNAMED
        );
        await expectError(
          await send('overridden', nodeEnv, { body }),
          HTTP_STATUS.UNPROCESSABLE,
          BODY_REFUSED
        );
      }
    );

    test.each(cases)(
      'a strict query with %s is the 422 naming no key, or the override',
      async (_label, keys) => {
        const query = `?${keys.map((key) => `${key}=1`).join('&')}`;
        await expectError(
          await send('plain', nodeEnv, { query }),
          HTTP_STATUS.UNPROCESSABLE,
          UNNAMED
        );
        await expectError(
          await send('overridden', nodeEnv, { query }),
          HTTP_STATUS.BAD_REQUEST,
          QUERY_REFUSED
        );
      }
    );

    test('keys that fit the budget are still named', async () => {
      await expectError(
        await send('plain', nodeEnv, { body: { stray: 1 } }),
        HTTP_STATUS.UNPROCESSABLE,
        MSG_UNRECOGNIZED_KEYS(['stray'], 0)
      );
    });
  });
});

describe('a repeated query key', () => {
  const entry = endpoint({
    method: 'GET',
    path: '/probe/:id',
    params: z.object({ id: idSchema }),
    query: z.object({ q: z.string().optional() }),
    status: 200,
    response: { raw: z.object({ q: z.string().optional() }) },
    policy: PUBLIC,
  });
  const app = { built: null as ReturnType<typeof CreateApp> | null };
  const get = async (path: string) => {
    if (!app.built) {
      const { createApp } = await import('@/app');
      app.built = createApp({
        bindings: [
          bind(entry, {
            failure: MSG_INTERNAL_ERROR,
            preAuthIpLimit: false,
            refusals: { params: { status: 404, message: MSG_NOT_FOUND } },
            detail,
            handler: async ({ query }) => ({ raw: { q: query.q } }),
          }),
        ],
        prefixes: [],
      });
    }
    return app.built.handle(new Request(`http://localhost${path}`));
  };

  test.each(['?q=1&q=2', '?q&q', '?q=1&x=1&q=1'])(
    'of a declared key, %s, is refused',
    async (query) => {
      await expectError(
        await get(`/probe/${id()}${query}`),
        HTTP_STATUS.UNPROCESSABLE,
        MSG_INVALID_INPUT
      );
    }
  );

  test.each([
    ['?x=1&x=2', {}],
    ['?q=1&Q=2', { q: '1' }],
  ])(
    'of a key the query does not declare, %s, means nothing to the route',
    async (query, body) => {
      const response = await get(`/probe/${id()}${query}`);
      expect([response.status, await response.json()]).toEqual([200, body]);
    }
  );

  test('comes after the params’ own refusal', async () => {
    await expectError(
      await get('/probe/not-an-id?q=1&q=2'),
      HTTP_STATUS.NOT_FOUND,
      MSG_NOT_FOUND
    );
  });
});

describe('a parse failure that names no cause', () => {
  test('is the body’s unreadable refusal, the binding’s override included', async () => {
    const { createApp } = await import('@/app');
    const app = createApp({
      bindings: [
        bind(
          endpoint({
            method: 'POST',
            path: '/probe/body',
            body: z.object({ name: z.string() }),
            status: 200,
            response: { raw: z.object({}) },
            policy: PUBLIC,
          }),
          {
            failure: MSG_INTERNAL_ERROR,
            preAuthIpLimit: false,
            refusals: {
              unreadableBody: { status: 401, message: MSG_NOT_FOUND },
            },
            detail,
            // What Elysia raises when a parser throws something that is not an Error.
            handler: () => Promise.reject(new ParseError()),
          }
        ),
      ],
      prefixes: [],
    });
    const response = await app.handle(
      new Request('http://localhost/probe/body', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a' }),
      })
    );
    await expectError(response, 401, MSG_NOT_FOUND);
  });
});

test('Elysia’s cookie error is a server fault: a logged 500, never a client’s 400', async () => {
  const { createApp } = await import('@/app');
  const app = createApp({
    bindings: [
      bind(
        endpoint({
          method: 'GET',
          path: '/probe/cookie',
          status: 200,
          response: { raw: z.object({}) },
          policy: PUBLIC,
        }),
        {
          failure: MSG_INTERNAL_ERROR,
          preAuthIpLimit: false,
          detail,
          // Raised only for signing, which nothing configures, or serialising.
          handler: () => Promise.reject(new InvalidCookie('session')),
        }
      ),
    ],
    prefixes: [],
  });
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  const response = await app.handle(
    new Request('http://localhost/probe/cookie')
  );
  const lines = logged.mock.calls.length;
  logged.mockRestore();
  await expectError(response, 500, MSG_INTERNAL_ERROR);
  expect(lines).toBeGreaterThan(0);
});
