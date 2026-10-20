/** Real listener coverage for Elysia's hostname-offset path extraction. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { app } from '@/app';

import { PROBLEM_MEDIA_TYPE } from '@app/shared/api/wire';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';

const state = { origin: '' };
const guardedPath = '/api/health/storage?deep=1';

beforeAll(() => {
  app.listen({ port: 0 });
  const server = app.server;
  if (!server) throw new Error('test listener did not start');
  state.origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await app.stop();
});

describe('Host-independent route extraction', () => {
  test.each(['x', 'abc', 'abcd', 'example.com'])(
    '/junk/api/... is 404 with Host %s',
    async (host) => {
      const response = await fetch(`${state.origin}/junk${guardedPath}`, {
        headers: { Host: host },
      });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
      expect(await response.json()).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: MSG_PAGE_NOT_FOUND,
      });
    }
  );

  // The suffix-dispatch cases specifically: a Host below the routable floor made
  // Elysia route on a SUFFIX of the requested path, so these reached real
  // handlers (200 from the health route, 401 from a dash route) while matching
  // no path-prefix edge rule and writing the crafted path into
  // `audit_logs.api_path`. The measured case was
  // `POST /zz/api/internal/sqlite-sweep`; that route is gone (`lib/maintenance/schedule.ts`),
  // so the same shape is driven through the routes that remain.
  test.each([
    ['x', '/qq/api/health/storage', 'GET'],
    ['abc', '/qq/api/health/storage', 'GET'],
    ['x', '/zzz/api/dash/roles', 'GET'],
    ['abc', '/zzz/api/dash/roles', 'GET'],
  ])(
    'Host %s cannot reach %s by prefix injection',
    async (host, path, method) => {
      const response = await fetch(`${state.origin}${path}`, {
        method,
        headers: { Host: host },
      });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    }
  );

  test('a short Host cannot reach a canonical path either', async () => {
    // The guard is on the hostname, not on the crafted prefix: a ≤3-character
    // Host is refused outright rather than routed by arithmetic that happens to
    // work for this particular path length.
    const response = await fetch(`${state.origin}${guardedPath}`, {
      headers: { Host: 'x' },
    });

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  test('normal route still resolves over the listener', async () => {
    const response = await fetch(`${state.origin}${guardedPath}`, {
      headers: { Host: 'example.com' },
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await response.json()).toEqual({ status: 'unauthorized' });
  });

  test.each(['http', 'https'])(
    '%s app.handle requests keep normal routing',
    async (scheme) => {
      const response = await app.handle(
        new Request(`${scheme}://example.com${guardedPath}`)
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(await response.json()).toEqual({ status: 'unauthorized' });
    }
  );
});
