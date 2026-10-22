/**
 * The access log covers the answers `app.ts` gives from `onRequest`.
 *
 * On Elysia 1.4 an `onRequest` answer returned before `onAfterResponse` was
 * scheduled, so the host guard's 404 and the declared-length 413 left no line at all
 * while carrying application semantics (a refused upload, a tripped guard).
 * OPTIONS stays unlogged by decision (`reports/should-ignore.md` #66).
 */
import { describe, expect, spyOn, test } from 'bun:test';

import { app } from '@/app';

import { HTTP_STATUS } from '@app/shared/http-status';

import { MAX_JSON_BODY_BYTES } from '@/lib/http/request';

import { baseHeaders } from '../helpers/session';

interface AccessLine {
  method: string;
  path: string;
  status: number;
}

function isAccessLine(value: unknown): value is AccessLine {
  return (
    typeof value === 'object' &&
    value !== null &&
    'msg' in value &&
    value.msg === 'request' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'status' in value &&
    typeof value.status === 'number'
  );
}

function parseAccessLine(first: unknown): AccessLine[] {
  if (typeof first !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(first);
    return isAccessLine(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

/** The response, and the access lines handling it wrote. */
async function handleLogged(
  request: Request
): Promise<{ status: number; lines: AccessLine[] }> {
  const logged = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const response = await app.handle(request);
    // `onAfterResponse` runs after the response resolves.
    await Bun.sleep(20);
    return {
      status: response.status,
      lines: logged.mock.calls.flatMap(([first]) => parseAccessLine(first)),
    };
  } finally {
    logged.mockRestore();
  }
}

describe('an answer from onRequest is logged like any other', () => {
  test('the host guard 404', async () => {
    const { status, lines } = await handleLogged(
      new Request('http://a/api/health/storage', { headers: baseHeaders() })
    );

    expect(status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(lines).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/api/health/storage',
        status: HTTP_STATUS.NOT_FOUND,
      }),
    ]);
  });

  test('the declared-length 413', async () => {
    const body = 'x'.repeat(MAX_JSON_BODY_BYTES + 4096);
    const { status, lines } = await handleLogged(
      new Request('http://localhost/api/dash/users', {
        method: 'POST',
        headers: baseHeaders({
          'content-type': 'application/json',
          'content-length': String(body.length),
        }),
        body,
      })
    );

    expect(status).toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
    expect(lines).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/api/dash/users',
        status: HTTP_STATUS.CONTENT_TOO_LARGE,
      }),
    ]);
  });

  test('a routed answer still logs exactly one line', async () => {
    // The control against a double line: this path reaches `onAfterResponse`.
    const { status, lines } = await handleLogged(
      new Request('http://localhost/api/does-not-exist', {
        headers: baseHeaders(),
      })
    );

    expect(status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(lines).toEqual([
      expect.objectContaining({
        path: '/api/does-not-exist',
        status: HTTP_STATUS.NOT_FOUND,
      }),
    ]);
  });

  test('OPTIONS stays unlogged', async () => {
    const { lines } = await handleLogged(
      new Request('http://localhost/api/does-not-exist', {
        method: 'OPTIONS',
        headers: baseHeaders(),
      })
    );

    expect(lines).toEqual([]);
  });
});

describe('the logged path is bounded', () => {
  test('a client path longer than the string cap is clamped', async () => {
    const { status, lines } = await handleLogged(
      new Request(`http://localhost/api/${'x'.repeat(2000)}`, {
        headers: baseHeaders(),
      })
    );

    expect(status).toBe(HTTP_STATUS.NOT_FOUND);
    const [line] = lines;
    expect(line?.path.startsWith('/api/xxx')).toBe(true);
    expect(line?.path.length).toBeLessThanOrEqual(256);
  });
});
