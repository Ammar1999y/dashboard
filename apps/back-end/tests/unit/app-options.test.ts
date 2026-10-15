/**
 * Options of the application itself that no behaviour test pins down on this
 * app: the live abort case in `auth-bindings.test.ts` also passes with
 * `abortSignal: true` here, and the reference page must never exist outside
 * development.
 */
import { describe, expect, test } from 'bun:test';

import { app, createApp } from '@/app';

import { PRE_AUTH_LIMIT } from '@/lib/http/pre-auth';
import { SECURITY_HEADERS } from '@/lib/http/security-headers';

describe('the application', () => {
  test('is built with `abortSignal: false`, so an aborted request still runs its after-response work', () => {
    expect(app['~config']?.abortSignal).toBe(false);
  });

  test('serves no reference page outside development', async () => {
    expect(process.env.NODE_ENV).not.toBe('development');
    const response = await app.handle(new Request('http://localhost/openapi'));
    expect(response.status).toBe(404);
  });
});

describe('the reference page, where it is mounted', () => {
  const page = (path = '/openapi', init: RequestInit = {}) =>
    createApp({
      bindings: [],
      prefixes: [],
      referencePage: true,
    }).handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { 'cf-connecting-ip': '203.0.113.7', ...init.headers },
      })
    );

  test('loads the pinned Scalar build and points it at the gated document', async () => {
    const response = await page();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/html');
    const html = await response.text();
    expect(html).toContain(
      '<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/dist/browser/standalone.js" integrity="sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK" crossorigin>'
    );
    expect(html).not.toContain('@latest');
    expect(html).toContain('"url":"/openapi.json"');
  });

  test('carries its own CSP, which admits that script alone; every other answer keeps the API’s', async () => {
    const response = await page();
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(
      'script-src https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/;'
    );
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain("script-src 'unsafe-inline'");

    const other = await page('/openapi/other');
    expect(other.headers.get('content-security-policy')).toBe(
      SECURITY_HEADERS['Content-Security-Policy'] ?? null
    );
  });

  test('answers HEAD as GET, without the body', async () => {
    const get = await page();
    const head = await page('/openapi', { method: 'HEAD' });
    const { byteLength } = await get.arrayBuffer();
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe(String(byteLength));
  });

  test('answers another method 405 with its Allow, as every route does', async () => {
    const response = await page('/openapi', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  test('redirects its slash form, for OPTIONS too', async () => {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await page('/openapi/?x=1', { method });
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe('/openapi?x=1');
    }
  });

  test('takes the per-IP admission limit every binding takes', async () => {
    const app = createApp({ bindings: [], prefixes: [], referencePage: true });
    const send = () =>
      app.handle(
        new Request('http://localhost/openapi', {
          headers: { 'cf-connecting-ip': '203.0.113.71' },
        })
      );
    const admitted = new Set<number>();
    for (let sent = 0; sent < PRE_AUTH_LIMIT; sent += 1) {
      const response = await send();
      admitted.add(response.status);
    }
    expect([...admitted]).toEqual([200]);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });

  test('answers a preflight as a known path', async () => {
    const response = await page('/openapi', {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'GET' },
    });
    expect(response.status).toBe(204);
  });
});
