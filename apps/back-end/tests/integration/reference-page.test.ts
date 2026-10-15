/**
 * X1: the Scalar page exists in development, the posture this tier runs in,
 * and holds no part of the document: it fetches `/openapi.json` with the
 * reader's own session. Its absence elsewhere is `tests/unit/app-options.test.ts`.
 */
import { expect, test } from 'bun:test';

import { app } from '@/app';

test('development serves the reference page, which carries no path of the API', async () => {
  expect(process.env.NODE_ENV).toBe('development');
  const response = await app.handle(new Request('http://localhost/openapi'));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('"url":"/openapi.json"');
  expect(html).not.toContain('/api/dash');
});
