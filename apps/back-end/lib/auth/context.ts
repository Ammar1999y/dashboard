import type { AuditMeta } from '@/lib/audit';
import type { GenericEndpointContext } from '@better-auth/core';
import type { createAuthMiddleware } from 'better-auth/api';

import { boundedAuditMeta, getClientIp } from '@/lib/audit';

export type AuthContext = GenericEndpointContext;

/** What a `hooks.before` / `hooks.after` middleware receives. */
export type HookContext = Parameters<
  Parameters<typeof createAuthMiddleware>[0]
>[0];

type RequestFields = Pick<GenericEndpointContext, 'headers' | 'request'>;

export function requestHeaders(ctx: RequestFields): Headers {
  return ctx.headers ?? ctx.request?.headers ?? new Headers();
}

/** Hooks see the body before any endpoint schema has parsed it. */
export function bodyRecord(ctx: { body?: unknown }): Record<string, unknown> {
  return ctx.body && typeof ctx.body === 'object'
    ? (ctx.body as Record<string, unknown>)
    : {};
}

export function authAuditMeta(
  ctx: RequestFields & Pick<GenericEndpointContext, 'path'>,
  path = ctx.path ?? '/auth'
): AuditMeta {
  const headers = requestHeaders(ctx);
  return boundedAuditMeta(
    getClientIp(headers),
    headers.get('user-agent'),
    path
  );
}
