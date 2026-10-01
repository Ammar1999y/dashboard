/**
 * Subprocess body for `route-feature-gates.test.ts`: `enabled` is read at
 * module load, so each feature configuration needs its own process. OTP is
 * switched by environment; the phone mode is a source constant, so
 * `phone-off` replaces it before anything reads it. Prints ONE line of JSON.
 */
import { mock } from 'bun:test';

import * as config from '@app/shared/config';

import { installEgressGuard } from '../helpers/egress';

if (process.argv[2] === 'phone-off')
  await mock.module('@app/shared/config', () => ({
    ...config,
    PHONE_ENABLED: false,
  }));

installEgressGuard();
const { REGISTERED_ROUTES, ROUTES } = await import('@/routes');
const { app } = await import('@/app');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { toPublishedManifest } = await import('@/lib/http/route-manifest');
const { handleApiError, requireFeature } = await import('@/lib/http/response');
const { baseHeaders } = await import('../helpers/session');

const GATED = process.argv.slice(3);

/** What the handler's own gate answers, the 404 the table now gives first. */
function featureAnswer(): { status: number | undefined; body: unknown } {
  try {
    requireFeature(false);
  } catch (error) {
    const { status, body } = handleApiError(error);
    return { status, body };
  }
  throw new Error('requireFeature(false) did not refuse.');
}

const registered = new Set(REGISTERED_ROUTES.map((route) => route.path));
const published = new Set(
  toPublishedManifest(REGISTERED_ROUTES).map((e) => e.path)
);
const deployed = new Set(toPublishedManifest(ROUTES, true).map((e) => e.path));

const routes = await Promise.all(
  GATED.map(async (path) => {
    const response = await app.handle(
      new Request(`${PUBLIC_ORIGIN}${path}`, {
        method: 'POST',
        headers: baseHeaders({
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: '{}',
      })
    );
    return {
      path,
      registered: registered.has(path),
      published: published.has(path),
      deployed: deployed.has(path),
      status: response.status,
      body: (await response.json()) as unknown,
    };
  })
);

console.log(JSON.stringify({ routes, featureAnswer: featureAnswer() }));
