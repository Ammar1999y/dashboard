/**
 * `Server-Timing` is a development aid only; outside development it is a
 * jitter-free duration for a timing probe against the anonymous auth paths.
 */
import { afterEach, expect, test } from 'bun:test';

import { applyResponsePolicy } from '@/lib/http/response-policy';

const initialNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = initialNodeEnv;
});

test.each(['test', 'production'])('is omitted under NODE_ENV=%s', (env) => {
  process.env.NODE_ENV = env;

  const response = applyResponsePolicy(new Response(null), {
    durationMs: 12.3,
  });

  expect(response.headers.get('server-timing')).toBeNull();
});

test('is emitted in development', () => {
  process.env.NODE_ENV = 'development';

  const response = applyResponsePolicy(new Response(null), {
    durationMs: 12.3,
  });

  expect(response.headers.get('server-timing')).toBe('app;dur=12.3');
});
