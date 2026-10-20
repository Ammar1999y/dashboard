/**
 * The bodies the API answers with, built in one place: a problem for every
 * refusal, `{ message, data, meta? }` for every success. What a running
 * application sends for each kind of refusal is `binding-pipeline.test.ts`'s,
 * and what Better Auth's prefix sends is `auth-problem.test.ts`'s.
 */
import { describe, expect, test } from 'bun:test';

import { endpoint } from '@app/shared/api/endpoint';
import {
  authProblemSchema,
  plainProblemSchema,
  PROBLEM_MEDIA_TYPE,
  problemBody,
  problemSchema,
  problemSchemaOf,
  successBody,
} from '@app/shared/api/wire';
import { FILE_BUSY_CODE, INVALID_RESPONSE_CODE } from '@app/shared/error-codes';
import { HTTP_STATUS, HTTP_STATUS_TITLES } from '@app/shared/http-status';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';
import { createdIdSchema } from '@app/shared/responses/common';

import { apiError, invalidResponse, toWebResponse } from '@/lib/http/response';
import { generateUuidV7 } from '@/lib/id';

const PUBLIC = {
  auth: 'public',
  captcha: false,
  reauth: false,
  rateLimited: false,
  checksPassword: false,
} as const;

describe('HTTP_STATUS_TITLES', () => {
  const refusals = Object.entries(HTTP_STATUS).filter(
    ([, status]) => status >= 400
  );

  test('names every 4xx and 5xx status', () => {
    expect(refusals.length).toBeGreaterThan(0);
    for (const [name, status] of refusals)
      expect(HTTP_STATUS_TITLES[status], name).toEqual(expect.any(String));
  });

  test('is the RFC 9110 reason phrase, and names nothing below 400', () => {
    expect(HTTP_STATUS_TITLES).toEqual({
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      409: 'Conflict',
      413: 'Content Too Large',
      422: 'Unprocessable Content',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      503: 'Service Unavailable',
    });
  });
});

describe('problemBody', () => {
  const ID = generateUuidV7();

  test('is about:blank, the status, its title and the detail', () => {
    const body = problemBody(404, 'غير موجود');
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'غير موجود',
    });
    expect(Object.keys(body)).toEqual(['type', 'title', 'status', 'detail']);
  });

  test('carries a code and ids when given, and omits both otherwise', () => {
    expect(problemBody(409, 'x', FILE_BUSY_CODE, { fileIds: [ID] })).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'x',
      code: FILE_BUSY_CODE,
      data: { fileIds: [ID] },
    });
    const plain = problemBody(409, 'x');
    expect(plain).not.toHaveProperty('code');
    expect(plain).not.toHaveProperty('data');
    expect(problemBody(409, 'x', undefined, undefined)).toEqual(plain);
  });

  test('omits the title of a status the map does not list, rather than inventing one', () => {
    const body = problemBody(418, 'x');
    expect(body).not.toHaveProperty('title');
    expect(body).toEqual({ type: 'about:blank', status: 418, detail: 'x' });
  });

  test('is parsed by every problem schema it fits', () => {
    const plain = problemBody(401, 'x', 'REAUTH_REQUIRED');
    expect(plainProblemSchema.parse(plain)).toEqual(plain);
    expect(problemSchema.parse(plain)).toEqual(plain);
    const withIds = problemBody(409, 'x', FILE_BUSY_CODE, { fileIds: [ID] });
    expect(problemSchema.parse(withIds)).toEqual(withIds);
    expect(
      authProblemSchema.parse({ ...plain, message: plain.detail })
    ).toEqual({ ...plain, message: plain.detail });
  });

  test('is refused by the schemas it does not fit', () => {
    expect(authProblemSchema.safeParse(problemBody(401, 'x')).success).toBe(
      false
    );
    expect(
      problemSchema.safeParse({ ...problemBody(401, 'x'), data: null }).success
    ).toBe(false);
    expect(
      problemSchema.safeParse({ ...problemBody(401, 'x'), type: 'urn:x' })
        .success
    ).toBe(false);
  });
});

describe('problemSchemaOf', () => {
  const entry = endpoint({
    method: 'PUT',
    path: '/api/dash/media',
    status: 200,
    response: createdIdSchema,
    errors: { 409: { codesWithIds: [FILE_BUSY_CODE] }, 404: { codes: ['X'] } },
    policy: PUBLIC,
  });

  test('is the one naming ids only at a status whose codes name them', () => {
    expect(problemSchemaOf(entry, 409)).toBe(problemSchema);
    expect(problemSchemaOf(entry, 404)).toBe(plainProblemSchema);
    expect(problemSchemaOf(entry, 500)).toBe(plainProblemSchema);
  });
});

describe('successBody', () => {
  test('is the message and data alone, with no success flag', () => {
    const body = successBody('تم', { id: 1 });
    expect(body).toEqual({ message: 'تم', data: { id: 1 } });
    expect(Object.keys(body)).toEqual(['message', 'data']);
  });

  test('adds meta only when given, and keeps a null data', () => {
    const meta = { page: 1, perPage: 10, total: 0, pageCount: 0 };
    expect(successBody('x', [], meta)).toEqual({
      message: 'x',
      data: [],
      meta,
    });
    expect(successBody('x', null)).toEqual({ message: 'x', data: null });
    expect(successBody('x', null)).not.toHaveProperty('meta');
  });
});

describe('toWebResponse', () => {
  test('sends a refusal as application/problem+json with its status', async () => {
    const response = toWebResponse(
      apiError({ message: 'x', status: 409, code: FILE_BUSY_CODE })
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'x',
      code: FILE_BUSY_CODE,
    });
  });

  test('sends a success as plain JSON', async () => {
    const response = toWebResponse({
      status: 200,
      body: successBody('x', { id: 1 }),
    });
    expect(response.headers.get('content-type')).toStartWith(
      'application/json'
    );
    expect(await response.json()).toEqual({ message: 'x', data: { id: 1 } });
  });

  test('sends a raw body as it is, whatever its shape', async () => {
    const response = toWebResponse({
      status: 200,
      body: { raw: { detail: 'a health body that happens to say detail' } },
    });
    expect(response.headers.get('content-type')).toStartWith(
      'application/json'
    );
  });
});

describe('invalidResponse', () => {
  test('is a 500 coded invalid_response, which a refusal that breaks its contract is not', () => {
    expect(invalidResponse()).toEqual({
      status: HTTP_STATUS.INTERNAL_ERROR,
      body: {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: HTTP_STATUS.INTERNAL_ERROR,
        detail: MSG_INTERNAL_ERROR,
        code: INVALID_RESPONSE_CODE,
      },
    });
    expect(
      apiError({
        message: MSG_INTERNAL_ERROR,
        status: HTTP_STATUS.INTERNAL_ERROR,
      }).body
    ).not.toHaveProperty('code');
  });
});
