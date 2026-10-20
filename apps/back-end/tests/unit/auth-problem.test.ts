/**
 * `toAuthProblem`, the one place a refusal under the Better Auth prefix
 * becomes an auth problem: the library's errors, localised or not, and the
 * ones the server gives around it. The same answers through a running
 * application are `auth-error-localisation.test.ts`'s.
 */
import { describe, expect, test } from 'bun:test';

import {
  authProblemSchema,
  PROBLEM_MEDIA_TYPE,
  problemBody,
} from '@app/shared/api/wire';
import {
  CUSTOM_AUTH_CODE,
  EMAIL_NOT_VERIFIED_CODE,
} from '@app/shared/error-codes';
import { betterAuthMsg } from '@app/shared/messages/auth';
import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
} from '@app/shared/messages/common';

import { toAuthProblem } from '@/lib/auth/errors';

const json = (body: unknown, status: number, headers?: HeadersInit) =>
  Response.json(body, { status, headers });

const detailOf = async (response: Response) => {
  const { body } = await problemOf(response);
  return body.detail;
};

async function problemOf(response: Response) {
  const answered = await toAuthProblem(response);
  expect(answered.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
  return { answered, body: authProblemSchema.parse(await answered.json()) };
}

function wordingOf(code: string): string {
  const wording = betterAuthMsg[code];
  if (wording === undefined) throw new Error(`no wording for ${code}`);
  return wording;
}

describe('a refusal under the prefix', () => {
  test('a mapped library error is worded here, with this project’s code, and repeats it as `message`', async () => {
    const { answered, body } = await problemOf(
      json({ code: 'INVALID_PASSWORD', message: 'Invalid password' }, 401)
    );
    expect(answered.status).toBe(401);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: wordingOf('INVALID_PASSWORD'),
      code: CUSTOM_AUTH_CODE,
      message: wordingOf('INVALID_PASSWORD'),
    });
  });

  test('a routing code is kept, not replaced by the project’s', async () => {
    const { body } = await problemOf(
      json(
        { code: EMAIL_NOT_VERIFIED_CODE, message: 'Email not verified' },
        403
      )
    );
    expect(body.code).toBe(EMAIL_NOT_VERIFIED_CODE);
    expect(body.detail).toBe(wordingOf(EMAIL_NOT_VERIFIED_CODE));
    expect(body.message).toBe(body.detail);
  });

  test('an unmapped library error keeps its own code and wording, as detail and as message', async () => {
    const { body } = await problemOf(
      json({ code: 'SOMETHING_NEW', message: 'Something new happened' }, 400)
    );
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Something new happened',
      code: 'SOMETHING_NEW',
      message: 'Something new happened',
    });
  });

  test('a body with no wording is the generic answer of its status', async () => {
    expect(await detailOf(json({ code: 'X' }, 400))).toBe(MSG_INVALID_INPUT);
    expect(await detailOf(json({}, 500))).toBe(MSG_INTERNAL_ERROR);
    expect(await detailOf(json({ message: '' }, 503))).toBe(MSG_INTERNAL_ERROR);
  });

  test('a problem a binding or the route built already gains `message` and keeps every member', async () => {
    const { body } = await problemOf(
      json(problemBody(429, 'تمهل', 'SLOW_DOWN'), 429)
    );
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'تمهل',
      code: 'SLOW_DOWN',
      message: 'تمهل',
    });
  });

  test('a status the title map does not list has no title', async () => {
    const { body } = await problemOf(json({ message: 'x' }, 418));
    expect(body).not.toHaveProperty('title');
    expect(body.status).toBe(418);
  });

  test('keeps the status, Retry-After and cookies of the answer it rewrites', async () => {
    const original = json({ message: 'x' }, 429, {
      'retry-after': '30',
      'content-length': '1000',
    });
    original.headers.append('set-cookie', 'a=1');
    const { answered } = await problemOf(original);
    expect(answered.status).toBe(429);
    expect(answered.headers.get('retry-after')).toBe('30');
    expect(answered.headers.getSetCookie()).toEqual(['a=1']);
    expect(answered.headers.get('content-length')).not.toBe('1000');
  });

  test.each([
    ['a success', () => json({ success: true }, 200)],
    ['a redirect', () => new Response(null, { status: 302 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 500 })],
    ['a body that is no object', () => json([1], 400)],
    ['a bare null', () => json(null, 400)],
    ['no body', () => new Response(null, { status: 404 })],
  ])('%s passes through untouched', async (_label, make) => {
    const response = make();
    expect(await toAuthProblem(response)).toBe(response);
  });
});
