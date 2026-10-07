/**
 * The runtime half of the response contract (`lib/http/response-check.ts`):
 * every success a keyed route answers, and every answer of our own Better Auth
 * plugin endpoints, is held to its published contract and to its status. Under
 * the runner a mismatch answers 500 and is recorded for the preload to fail the
 * test with; in development it is only logged; production never checks.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Handler, HandlerOutput } from '@/lib/http/contract';
import type { ResponseRoute } from '@app/shared/response-contract';

import { ROUTES } from '@/routes';

import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_FETCHED } from '@app/shared/messages/common';

import { buildRequestMeta, withBodyPolicy } from '@/lib/http/request';
import { apiSuccess } from '@/lib/http/response';
import {
  checkBetterAuthResponse,
  responseCheckMode,
  withResponseCheck,
} from '@/lib/http/response-check';
import {
  describeResponseCoverage,
  expectedResponseCoverage,
} from '@/lib/http/response-coverage';
import { takeResponseMismatches } from '@/lib/http/response-mismatches';
import { toRegisteredRoutes } from '@/lib/http/route-manifest';
import { generateUuidV7 } from '@/lib/id';

import { mediaFileWire, PAGE_META } from '../helpers/response-fixtures';

const ctx = withBodyPolicy(
  buildRequestMeta(new Request('http://localhost/api/dash/media/files')),
  'none'
);

/** A handler keyed `key` that answers `output` whatever it is asked. */
const answering = (key: ResponseRoute, output: HandlerOutput): Handler =>
  Object.assign(async () => output, { routeKey: key });

const success = (
  data: unknown,
  status: number = HTTP_STATUS.OK
): HandlerOutput => ({
  status,
  body: { success: true, message: MSG_FETCHED, data },
});

const logged = spyOn(console, 'error').mockImplementation(() => {});
beforeEach(() => {
  logged.mockClear();
});
afterAll(() => {
  logged.mockRestore();
});

describe('under the runner', () => {
  test('an answer within its contract passes through untouched', async () => {
    const output = success(mediaFileWire(), HTTP_STATUS.CREATED);
    const checked = withResponseCheck(
      answering('POST /api/dash/media/files', output),
      'enforce'
    );
    expect(await checked(ctx)).toBe(output);
    expect(takeResponseMismatches()).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  const id = generateUuidV7();
  const cases: readonly [string, ResponseRoute, HandlerOutput, string][] = [
    [
      'a key the contract does not name',
      'POST /api/upload/file',
      success([{ ...mediaFileWire(), r2Key: 'private/x' }], 201),
      'data.0: unrecognized_keys',
    ],
    [
      'a malformed id',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), id: crypto.randomUUID() }, 201),
      'data.id: invalid_format',
    ],
    [
      'a malformed date',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), createdAt: 'yesterday' }, 201),
      'data.createdAt: invalid_format',
    ],
    [
      'an enum that exists only as metadata',
      'POST /api/dash/media/files',
      success({ ...mediaFileWire(), mimeType: 'text/html' }, 201),
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
    [
      'a wrong status',
      'POST /api/dash/media/files',
      success(mediaFileWire(), HTTP_STATUS.OK),
      'status 200, expected 201',
    ],
  ];

  test.each(cases)(
    '%s answers 500 and is recorded',
    async (_name, key, output, problem) => {
      const answer = await withResponseCheck(
        answering(key, output),
        'enforce'
      )(ctx);
      expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
      expect(answer.body).toMatchObject({ success: false, data: null });
      const [recorded, ...rest] = takeResponseMismatches();
      expect(rest).toEqual([]);
      expect(recorded).toStartWith(`${key}: `);
      expect(recorded).toContain(problem);
    }
  );

  test('the log names the route and each problem, never a value', async () => {
    const secret = 'not-an-id-but-a-secret';
    await withResponseCheck(
      answering(
        'POST /api/dash/media/files',
        success({ ...mediaFileWire(), id: secret }, HTTP_STATUS.CREATED)
      ),
      'enforce'
    )(ctx);
    takeResponseMismatches();
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('POST /api/dash/media/files');
    expect(line).toContain('data.id: invalid_format');
    expect(line).not.toContain(secret);
  });

  test('a refusal, and a handler without a key, are left alone', async () => {
    const refusal: HandlerOutput = {
      status: HTTP_STATUS.NOT_FOUND,
      body: { success: false, message: 'gone', data: null },
    };
    expect(
      await withResponseCheck(
        answering('GET /api/dash/media/files/:id', refusal),
        'enforce'
      )(ctx)
    ).toBe(refusal);

    const unkeyed: Handler = async () => success({ anything: true });
    expect(withResponseCheck(unkeyed, 'enforce')).toBe(unkeyed);
    expect(takeResponseMismatches()).toEqual([]);
  });

  test('the checked handler keeps its key, which the document build reads', () => {
    const route = ROUTES.find((entry) => entry.handler.routeKey !== undefined);
    if (!route) throw new Error('no keyed route in the table');
    expect(withResponseCheck(route.handler, 'enforce').routeKey).toBe(
      route.handler.routeKey
    );
  });

  test('meta on a paginated answer is held to its own schema', async () => {
    const answer = await withResponseCheck(
      answering(
        'GET /api/dash/permissions',
        apiSuccess({
          message: MSG_FETCHED,
          data: [],
          meta: { ...PAGE_META, page: 0 },
        })
      ),
      'enforce'
    )(ctx);
    expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(takeResponseMismatches()).toEqual([
      'GET /api/dash/permissions: meta.page: too_small',
    ]);
  });
});

describe('in development', () => {
  test('a mismatch is logged and the answer goes out as it was', async () => {
    const output = success(
      { ...mediaFileWire(), id: 'x' },
      HTTP_STATUS.CREATED
    );
    const answer = await withResponseCheck(
      answering('POST /api/dash/media/files', output),
      'log'
    )(ctx);
    expect(answer).toBe(output);
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

  test('no registered handler is wrapped', () => {
    const registered = toRegisteredRoutes(ROUTES, false, null);
    const tableHandlers = new Set(ROUTES.map((entry) => entry.handler));
    expect(registered.length).toBeGreaterThan(0);
    for (const route of registered)
      expect(tableHandlers.has(route.handler)).toBe(true);
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
    const response = json({ success: true, data: { trusted: true } });
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
      () => json({ success: true, message: 'x', data: { trusted: true } }),
      'body: unrecognized_keys',
    ],
    [
      'data: null on a body without data',
      '/two-factor/disable',
      () => json({ success: true, message: 'done', data: null }),
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
      () => json({ success: true, data: { url: 'javascript:alert(1)' } }),
      'data.url: invalid_format',
    ],
    [
      'an extra key in the WebAuthn options',
      '/two-factor/passkey/options',
      () => json({ success: true, data: { ...options, extra: 1 } }),
      'data: unrecognized_keys',
    ],
    [
      'user verification that is not required',
      '/reauth/passkey/options',
      () =>
        json({
          success: true,
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
      () => json({ success: true, data: { trusted: true } }, 201),
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
      expect(await answer.json()).toMatchObject({ success: false, data: null });
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
    const broken = json({ success: true, message: 'x', data: null });
    expect(
      await checkBetterAuthResponse(null, '/two-factor/disable', 'POST', broken)
    ).toBe(broken);
    expect(takeResponseMismatches()).toEqual([]);
  });

  test('in development a mismatch is logged and the answer goes out as it was', async () => {
    const broken = json({ success: true, data: { trusted: false } });
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
