/**
 * The runtime half of the response contract (`lib/http/response-check.ts`):
 * every success a binding answers, its refusals' statuses and codes, and every
 * answer of our own Better Auth plugin endpoints, is held to its published
 * contract. Under the runner a mismatch answers 500 and is recorded for the
 * preload to fail the test with; in development it is only logged; production
 * never checks.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import type { createApp as CreateApp } from '@/app';
import type { PaginationMeta } from '@app/shared/types/api';

import * as z from 'zod';

import { endpoint } from '@app/shared/api/endpoint';
import { successBody } from '@app/shared/api/wire';
import { CustomError } from '@app/shared/error-class';
import {
  FILE_BUSY_CODE,
  FILE_IN_USE_CODE,
  INVALID_RESPONSE_CODE,
} from '@app/shared/error-codes';
import { HTTP_STATUS } from '@app/shared/http-status';
import {
  MSG_FETCHED,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
} from '@app/shared/messages/common';
import { createdIdSchema } from '@app/shared/responses/common';

import { bind } from '@/lib/http/binding';
import {
  checkBetterAuthResponse,
  checkSuccess,
  responseCheckMode,
} from '@/lib/http/response-check';
import {
  describeResponseCoverage,
  expectedResponseCoverage,
} from '@/lib/http/response-coverage';
import { takeResponseMismatches } from '@/lib/http/response-mismatches';
import { generateUuidV7 } from '@/lib/id';

import { entryAt } from '../helpers/entries';
import { expectError } from '../helpers/expect-body';
import { mediaFileWire, PAGE_META } from '../helpers/response-fixtures';

/** The body `run()` builds for a binding's success. */
const success = (data: unknown, meta?: PaginationMeta) =>
  successBody(MSG_FETCHED, data, meta);

const at = (key: string) => ({ entry: entryAt(key), key });

const logged = spyOn(console, 'error').mockImplementation(() => {});
beforeEach(() => {
  logged.mockClear();
});
afterAll(() => {
  logged.mockRestore();
});

describe('under the runner', () => {
  test('an answer within its contract passes', () => {
    expect(
      checkSuccess(
        'enforce',
        at('POST /api/dash/media/files'),
        success(mediaFileWire())
      )
    ).toBe(true);
    expect(takeResponseMismatches()).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  const id = generateUuidV7();
  const cases: readonly [string, string, unknown, string][] = [
    [
      'a key the contract does not name',
      'POST /api/upload/file',
      success([{ ...mediaFileWire(), r2Key: 'private/x' }]),
      'data.0: unrecognized_keys',
    ],
    [
      'a malformed id',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), id: crypto.randomUUID() }),
      'data.id: invalid_format',
    ],
    [
      'a malformed date',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), createdAt: 'yesterday' }),
      'data.createdAt: invalid_format',
    ],
    [
      // The value is judged, not its JSON: Elysia's schema refuses it too.
      'a date the handler left a `Date`',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), createdAt: new Date() }),
      'data.createdAt: invalid_type',
    ],
    [
      'an enum that exists only as metadata',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), mimeType: 'text/html' }),
      'data.mimeType: invalid_value',
    ],
    [
      'a constant that exists only as metadata',
      'POST /api/auth/otp/send',
      success({ nextAllowedIn: 31 }),
      'data.nextAllowedIn: invalid_value',
    ],
    [
      'duplicate ids',
      'DELETE /api/dash/media/files',
      success({ deleted: [id, id], pending: [] }),
      'data.deleted.1: custom',
    ],
    [
      'a body matching two branches',
      'POST /api/dash/users/me/change-email',
      success({ autoVerified: true, otpSent: true }),
      'data: invalid_union',
    ],
    [
      'a paginated answer without meta',
      'GET /api/dash/permissions',
      success([]),
      'meta: invalid_type',
    ],
  ];

  test.each(cases)(
    '%s is refused and recorded',
    (_name, key, body, problem) => {
      expect(checkSuccess('enforce', at(key), body)).toBe(false);
      const [recorded, ...rest] = takeResponseMismatches();
      expect(rest).toEqual([]);
      expect(recorded).toStartWith(`${key}: `);
      expect(recorded).toContain(problem);
    }
  );

  test('the log names the route and each problem, never a value', () => {
    const secret = 'not-an-id-but-a-secret';
    checkSuccess(
      'enforce',
      at('POST /api/dash/media/files'),
      success({ ...mediaFileWire(), id: secret })
    );
    takeResponseMismatches();
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('POST /api/dash/media/files');
    expect(line).toContain('data.id: invalid_format');
    expect(line).not.toContain(secret);
  });

  test('meta on a paginated answer is held to its own schema', () => {
    expect(
      checkSuccess(
        'enforce',
        at('GET /api/dash/permissions'),
        success([], { ...PAGE_META, page: 0 })
      )
    ).toBe(false);
    expect(takeResponseMismatches()).toEqual([
      'GET /api/dash/permissions: meta.page: too_small',
    ]);
  });
});

describe('in development', () => {
  test('a mismatch is logged and the answer goes out as it was', () => {
    expect(
      checkSuccess(
        'log',
        at('POST /api/dash/media/files'),
        success({ ...mediaFileWire(), id: 'x' })
      )
    ).toBe(true);
    expect(takeResponseMismatches()).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  test('is the mode without the runner variable', () => {
    expect(responseCheckMode({ NODE_ENV: 'development' })).toBe('log');
    expect(
      responseCheckMode({
        NODE_ENV: 'development',
        RESPONSE_CONTRACT_CHECK: 'enforce',
      })
    ).toBe('enforce');
    expect(() =>
      responseCheckMode({ NODE_ENV: 'test', RESPONSE_CONTRACT_CHECK: 'on' })
    ).toThrow('RESPONSE_CONTRACT_CHECK must be "enforce" or unset');
  });
});

describe('in production', () => {
  test('the check is off, and the runner variable is ignored', () => {
    expect(
      responseCheckMode({
        NODE_ENV: 'production',
        RESPONSE_CONTRACT_CHECK: 'enforce',
      })
    ).toBeNull();
    expect(
      responseCheckMode({
        NODE_ENV: 'production',
        RESPONSE_CONTRACT_CHECK: 'nonsense',
      })
    ).toBeNull();
  });
});

describe('at the Better Auth prefix route', () => {
  const challenge = {
    twoFactorRedirect: true,
    twoFactorMethods: ['otp'],
    twoFactorOptions: [
      {
        id: 'otp:email',
        method: 'otp',
        contactKind: 'email',
        channel: 'email',
        nextAllowedIn: 0,
      },
    ],
    defaultMethod: 'otp:email',
  };
  const options = {
    rpId: 'localhost',
    challenge: 'b0Wfz4Tn7Ow7S1aSvbM3MFkzr8E',
    allowCredentials: [
      { id: 'AbCd-_12', type: 'public-key', transports: ['internal'] },
    ],
    timeout: 60_000,
    userVerification: 'required',
  };
  const { twoFactorMethods: _methods, ...challengeWithoutMethods } = challenge;

  const json = (body: unknown, status: number = HTTP_STATUS.OK) =>
    Response.json(body, { status });
  const redirect = (location?: string) =>
    new Response(null, {
      status: 302,
      headers: location === undefined ? {} : { location },
    });

  test('an answer within its registry entry passes through untouched', async () => {
    const response = json({ data: { trusted: true } });
    expect(
      await checkBetterAuthResponse(
        'enforce',
        '/two-factor/trust-device',
        'POST',
        response
      )
    ).toBe(response);
    const redirected = redirect('http://localhost/finish');
    expect(
      await checkBetterAuthResponse(
        'enforce',
        '/oauth/google/callback',
        'GET',
        redirected
      )
    ).toBe(redirected);
    expect(takeResponseMismatches()).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  const cases: readonly [string, string, () => Response, string][] = [
    [
      'a stray message',
      '/two-factor/trust-device',
      () => json({ message: 'x', data: { trusted: true } }),
      'body: unrecognized_keys',
    ],
    [
      'the retired success flag',
      '/two-factor/trust-device',
      () => json({ success: true, data: { trusted: true } }),
      'body: unrecognized_keys',
    ],
    [
      'data: null on a body without data',
      '/two-factor/disable',
      () => json({ message: 'done', data: null }),
      'body: unrecognized_keys',
    ],
    [
      'a challenge missing twoFactorMethods',
      '/passwordless/verify',
      () => json(challengeWithoutMethods),
      'twoFactorMethods: invalid_type',
    ],
    [
      "the same challenge from the library's own sign-in",
      '/sign-in/email',
      () => json(challengeWithoutMethods),
      'twoFactorMethods: invalid_type',
    ],
    [
      'an OAuth URL with a javascript: scheme',
      '/oauth/google/start',
      () => json({ data: { url: 'javascript:alert(1)' } }),
      'data.url: invalid_format',
    ],
    [
      'an extra key in the WebAuthn options',
      '/two-factor/passkey/options',
      () => json({ data: { ...options, extra: 1 } }),
      'data: unrecognized_keys',
    ],
    [
      'user verification that is not required',
      '/reauth/passkey/options',
      () =>
        json({
          data: { ...options, userVerification: 'preferred' },
        }),
      'data.userVerification: invalid_value',
    ],
    [
      'an option id no factor has',
      '/passwordless/verify',
      () => json({ ...challenge, defaultMethod: 'otp:unknown' }),
      'defaultMethod: invalid_value',
    ],
    [
      'a wrong status',
      '/two-factor/trust-device',
      () => json({ data: { trusted: true } }, 201),
      'status 201, expected 200',
    ],
    [
      'a redirect from a path that answers a body',
      '/two-factor/trust-device',
      () => redirect('http://localhost/finish'),
      'status 302, expected 200',
    ],
    [
      'a redirect without a Location',
      '/oauth/google/callback',
      () => redirect(),
      'status 302 without a Location',
    ],
    [
      'a body that is not JSON',
      '/two-factor/methods',
      () => new Response('<html>'),
      'body: not JSON',
    ],
  ];

  test.each(cases)(
    '%s answers 500 and is recorded',
    async (_name, route, response, problem) => {
      const answer = await checkBetterAuthResponse(
        'enforce',
        route,
        'POST',
        response()
      );
      expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
      const refusal = await expectError(
        answer,
        HTTP_STATUS.INTERNAL_ERROR,
        MSG_INTERNAL_ERROR
      );
      expect(refusal.code).toBe(INVALID_RESPONSE_CODE);
      const [recorded, ...rest] = takeResponseMismatches();
      expect(rest).toEqual([]);
      expect(recorded).toStartWith(`Better Auth ${route}: `);
      expect(recorded).toContain(problem);
    }
  );

  test('a refusal, a library body, a HEAD and production are left alone', async () => {
    const refusal = json(
      { message: 'no', code: 'X' },
      HTTP_STATUS.UNAUTHORIZED
    );
    const session = json({ session: {}, user: {} });
    const head = new Response(null);
    expect(
      await checkBetterAuthResponse(
        'enforce',
        '/two-factor/disable',
        'POST',
        refusal
      )
    ).toBe(refusal);
    expect(
      await checkBetterAuthResponse('enforce', '/get-session', 'GET', session)
    ).toBe(session);
    expect(
      await checkBetterAuthResponse('enforce', '/capabilities', 'HEAD', head)
    ).toBe(head);
    const broken = json({ message: 'x', data: null });
    expect(
      await checkBetterAuthResponse(null, '/two-factor/disable', 'POST', broken)
    ).toBe(broken);
    expect(takeResponseMismatches()).toEqual([]);
  });

  test('in development a mismatch is logged and the answer goes out as it was', async () => {
    const broken = json({ data: { trusted: false } });
    expect(
      await checkBetterAuthResponse(
        'log',
        '/two-factor/trust-device',
        'POST',
        broken
      )
    ).toBe(broken);
    expect(takeResponseMismatches()).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  test('coverage names each union member, the redirect and the borrowed challenge', () => {
    const expected = expectedResponseCoverage();
    expect(expected).toEqual(
      expect.arrayContaining([
        'Better Auth /passwordless/verify #0',
        'Better Auth /passwordless/verify #1',
        'Better Auth /two-factor/otp/verify #1',
        'Better Auth /oauth/google/callback 302',
        'Better Auth /sign-in/email challenge',
        'Better Auth /two-factor/disable',
      ])
    );
    expect(
      describeResponseCoverage('Better Auth /two-factor/otp/verify #1')
    ).toBe('Better Auth /two-factor/otp/verify #1 {method, channel}');
  });
});

describe('a binding under the runner', () => {
  const KEY = 'POST /api/dash/permissions';
  const ID = generateUuidV7();
  const entry = endpoint({
    method: 'POST',
    path: '/api/dash/permissions',
    query: z.strictObject({}),
    body: z.object({ name: z.string() }),
    status: 201,
    response: createdIdSchema,
    errors: {
      404: { codes: ['DECLARED'] },
      409: {
        codes: ['PLAIN'],
        codesWithIds: [FILE_BUSY_CODE, FILE_IN_USE_CODE],
      },
    },
    policy: {
      auth: 'public',
      captcha: false,
      reauth: false,
      rateLimited: false,
      checksPassword: false,
    },
  });
  const next: { answer: 'ok' | 'extra' | CustomError } = { answer: 'ok' };
  const state: { app: ReturnType<typeof CreateApp> | null } = { app: null };

  beforeAll(async () => {
    const { createApp } = await import('@/app');
    state.app = createApp({
      bindings: [
        bind(entry, {
          failure: MSG_INTERNAL_ERROR,
          preAuthIpLimit: false,
          refusals: {
            query: {
              status: HTTP_STATUS.BAD_REQUEST,
              message: MSG_INVALID_INPUT,
            },
          },
          detail: { summary: 'synthetic', tags: ['Permissions'] },
          handler: async () => {
            const { answer } = next;
            if (answer instanceof CustomError) throw answer;
            const data = { id: generateUuidV7() };
            // A key the contract does not name, which the framework's own
            // schema would strip: only the contract check refuses it.
            return {
              message: 'ok',
              data:
                answer === 'ok'
                  ? data
                  : ({ ...data, secret: 'LEAK' } as typeof data),
            };
          },
        }),
      ],
      prefixes: [],
    });
  });

  const post = (
    answer: typeof next.answer,
    { query = '', body = '{"name":"a"}' } = {}
  ) => {
    if (!state.app) throw new Error('not built');
    next.answer = answer;
    return state.app.handle(
      new Request(`http://localhost/api/dash/permissions${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    );
  };

  test('a success within its contract and the published refusals pass', async () => {
    const created = await post('ok');
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const declared = await expectError(
      await post(new CustomError('x', 404, 'DECLARED')),
      404
    );
    expect(declared.code).toBe('DECLARED');
    expect(declared).not.toHaveProperty('data');
    const named = await expectError(
      await post(new CustomError('x', 409, FILE_BUSY_CODE, { fileIds: [ID] })),
      409
    );
    expect(named.data).toEqual({ fileIds: [ID] });
    // Its referrer can be gone by the time it is looked up.
    expect(
      await expectError(
        await post(new CustomError('x', 409, FILE_IN_USE_CODE)),
        409
      )
    ).not.toHaveProperty('data');
    await expectError(await post(new CustomError('x', 409, 'PLAIN')), 409);
    // A 400 of the input, not the handler's: published without `errors[400]`.
    await expectError(
      await post('ok', { query: '?a=1' }),
      400,
      MSG_INVALID_INPUT
    );
    await expectError(await post('ok', { body: '{' }), 400);
    expect(takeResponseMismatches()).toEqual([]);
  });

  test('a success outside its contract answers 500 invalid_response and is recorded', async () => {
    const problem = await expectError(
      await post('extra'),
      500,
      MSG_INTERNAL_ERROR
    );
    expect(problem.code).toBe(INVALID_RESPONSE_CODE);
    expect(takeResponseMismatches()).toEqual([
      `${KEY}: data: unrecognized_keys`,
    ]);
  });

  test.each([
    [
      'an undeclared code',
      new CustomError('x', 404, 'UNDECLARED'),
      'code UNDECLARED is not declared at 404',
    ],
    [
      'a status the entry does not publish',
      new CustomError('x', 401),
      'status 401 is not published',
    ],
    [
      'ids under a code the entry declares without them',
      new CustomError('x', 409, 'PLAIN', { fileIds: [ID] }),
      'code PLAIN names ids at 409, which the entry does not declare',
    ],
    [
      'ids at a status that declares none',
      new CustomError('x', 404, 'DECLARED', { folderIds: [ID] }),
      'code DECLARED names ids at 404, which the entry does not declare',
    ],
    [
      'ids without a code',
      new CustomError('x', 409, undefined, { fileIds: [ID] }),
      'ids without a code at 409',
    ],
    [
      'no ids under a code the entry declares with them',
      new CustomError('x', 409, FILE_BUSY_CODE),
      'code FILE_BUSY names no ids at 409',
    ],
    [
      'a business 400 the entry does not declare',
      new CustomError('x', 400),
      'a business 400 is not declared',
    ],
  ] as const)(
    '%s answers 500 and is recorded',
    async (_name, answer, problem) => {
      const refusal = await expectError(
        await post(answer),
        500,
        MSG_INTERNAL_ERROR
      );
      expect(refusal.code).toBeUndefined();
      expect(takeResponseMismatches()).toEqual([`${KEY}: ${problem}`]);
    }
  );
});
