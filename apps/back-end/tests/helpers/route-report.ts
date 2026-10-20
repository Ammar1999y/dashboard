import { expect } from 'bun:test';

import { app } from '@/app';
import { BINDINGS, REGISTERED_BINDINGS, registeredBindings } from '@/modules';
import { generateDocument } from '@/server/elysia/openapi';

import { problemBody } from '@app/shared/api/wire';
import { HTTP_STATUS } from '@app/shared/http-status';
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

/**
 * A withheld route is the route miss: a problem, which under the Better Auth
 * prefix repeats `detail` as `message`, because the prefix's handler, not a
 * binding, answers there.
 */
export function expectWithheld(
  report: readonly RouteState[],
  paths: readonly string[]
): void {
  for (const path of paths) {
    const miss = problemBody(HTTP_STATUS.NOT_FOUND, MSG_PAGE_NOT_FOUND);
    expect(report.find((route) => route.path === path)).toEqual({
      path,
      registered: false,
      published: false,
      deployed: false,
      status: HTTP_STATUS.NOT_FOUND,
      body: path.startsWith(`${BETTER_AUTH_ROUTE_PREFIX.prefix}/`)
        ? { ...miss, message: MSG_PAGE_NOT_FOUND }
        : miss,
    });
  }
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
