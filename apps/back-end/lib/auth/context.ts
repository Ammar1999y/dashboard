import type { AuditMeta } from '@/lib/audit';
import type { GenericEndpointContext } from '@better-auth/core';
import type { createAuthMiddleware } from 'better-auth/api';
import type * as z from 'zod';

import { HTTP_STATUS } from '@app/shared/http-status';

import { boundedAuditMeta } from '@/lib/audit';
import { getClientIp } from '@/lib/http/client-ip';

import { authError } from './errors';

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

/**
 * `context` whose `internalAdapter` records the first fault any call raises.
 * The library swallows some: the two-factor plugin's `beginAttempt` answers a
 * failed counter consume with 401 and drops a failed re-arm, and
 * `getSessionFromCtx` answers any fault as no session, so the fault would read
 * as a refusal. The caller rethrows the fault for its boundary to log, so the
 * library's own line for it is dropped.
 */
export function recordingFaults(context: AuthContext['context']) {
  const seen: { fault?: { error: unknown } } = {};
  const record = (error: unknown) => {
    seen.fault ??= { error };
    return error;
  };
  const adapter = new Proxy(context.internalAdapter, {
    get: (target, property, receiver) => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result: unknown = Reflect.apply(value, target, args);
          return result instanceof Promise
            ? result.catch((error: unknown) => {
                throw record(error);
              })
            : result;
        } catch (error) {
          throw record(error);
        }
      };
    },
  });
  const logger = new Proxy(context.logger, {
    get: (target, property, receiver) => {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== 'error' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (seen.fault && args.includes(seen.fault.error)) return;
        Reflect.apply(value, target, args);
      };
    },
  });
  return {
    context: new Proxy(context, {
      get: (target, property) =>
        property === 'internalAdapter'
          ? adapter
          : property === 'logger'
            ? logger
            : Reflect.get(target, property),
    }),
    fault: () => seen.fault,
  };
}

export function parseAuthBody<S extends z.ZodType>(
  ctx: { body?: unknown },
  schema: S,
  message: string
): z.output<S> {
  const parsed = schema.safeParse(ctx.body);
  if (!parsed.success) throw authError(HTTP_STATUS.UNPROCESSABLE, message);
  return parsed.data;
}
