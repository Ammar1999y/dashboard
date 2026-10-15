import { expect } from 'bun:test';

import { app } from '@/app';
import { BINDINGS, REGISTERED_BINDINGS, registeredBindings } from '@/modules';
import { generateDocument } from '@/server/elysia/openapi';

import { MSG_PAGE_NOT_FOUND } from '@app/shared/messages/common';

import {
  BETTER_AUTH_ALLOWED_PATH_SET,
  BETTER_AUTH_KNOWN_PATHS,
  BETTER_AUTH_ROUTE_PREFIX,
} from '@/lib/auth/allowed-paths';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { baseHeaders } from './session';

/** The bindings switched off with the OTP channel list. */
export const OTP_ROUTES = [
  '/api/auth/forgot-password/reset',
  '/api/auth/forgot-password/second-factor/send',
  '/api/auth/forgot-password/complete',
  '/api/auth/forgot-password/send',
  '/api/auth/otp/send',
  '/api/auth/otp/verify',
  '/api/auth/passwordless/send',
];

/** The bindings switched off with the phone mode. */
export const PHONE_ROUTES = [
  '/api/dash/users/me/change-phone',
  '/api/dash/users/me/change-phone/verify',
];

/** A Better Auth path switched off with the OTP channel list. */
const OTP_AUTH_PATH = '/passwordless/verify';

export interface RouteState {
  path: string;
  registered: boolean;
  published: boolean;
  deployed: boolean;
  status: number;
  body: unknown;
}

/**
 * Whether each gated route is registered, published and deployed in this
 * process, and how it answers an anonymous empty body.
 */
export async function routeReport(): Promise<RouteState[]> {
  const registered = new Set(
    REGISTERED_BINDINGS.map(({ entry }) => entry.path)
  );
  // The gated paths carry no parameter, so a document path is the route's own.
  const document = await generateDocument(app, REGISTERED_BINDINGS);
  const published = new Set(Object.keys(document.paths));
  const deployed = new Set(
    registeredBindings(BINDINGS, false).map(({ entry }) => entry.path)
  );
  const routes: RouteState[] = [];
  for (const path of [...OTP_ROUTES, ...PHONE_ROUTES]) {
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
    routes.push({
      path,
      registered: registered.has(path),
      published: published.has(path),
      deployed: deployed.has(path),
      status: response.status,
      body: (await response.json()) as unknown,
    });
  }
  return routes;
}

/** The 404 the handlers' own feature gate gave, frozen with the wire format. */
export function expectWithheld(
  report: readonly RouteState[],
  paths: readonly string[]
): void {
  for (const path of paths)
    expect(report.find((route) => route.path === path)).toEqual({
      path,
      registered: false,
      published: false,
      deployed: false,
      status: 404,
      body: { success: false, message: MSG_PAGE_NOT_FOUND, data: null },
    });
}

export function expectServed(
  report: readonly RouteState[],
  paths: readonly string[]
): void {
  for (const path of paths) {
    const route = report.find((entry) => entry.path === path);
    expect(route).toMatchObject({
      registered: true,
      published: true,
      deployed: true,
    });
    expect(route?.status).not.toBe(404);
  }
}

/** Absent from the allowlist, `app.ts` answers the path as an unknown one. */
export function otpAuthPathState(): Record<string, boolean> {
  return {
    allowed: BETTER_AUTH_ALLOWED_PATH_SET.has(OTP_AUTH_PATH),
    known: BETTER_AUTH_KNOWN_PATHS.has(OTP_AUTH_PATH),
    routed: BETTER_AUTH_ROUTE_PREFIX.paths.some(
      (entry) => entry.path === OTP_AUTH_PATH
    ),
  };
}
