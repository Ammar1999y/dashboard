/**
 * Bindings, onto an instance that already carries every hook. Each GET is
 * registered for HEAD too: Elysia 2 answers HEAD with 404 without a route of
 * its own, and `elysia/auto-head` drops the body's length.
 */
import type { GatedApp } from '@/app';
import type { AnyBinding } from '@/lib/http/binding';

import * as z from 'zod';

import { isRawResponse } from '@app/shared/api/endpoint';
import { refusalEnvelopeOf } from '@app/shared/response-contract';

import { successSchemaOf } from '@/lib/http/binding';
import { refusalsOf } from '@/lib/http/refusals';
import { toWebResponse } from '@/lib/http/response';
import { runBinding } from '@/lib/http/run';

import { answerValue } from './respond';

const envelopes = new Map<z.ZodType, z.ZodType>();

/** Each envelope compiled once: every refusal status of every binding declares one. */
function compiledEnvelope(schema: z.ZodType): z.ZodType {
  let compiled = envelopes.get(schema);
  if (!compiled) {
    compiled = z.compile(schema);
    envelopes.set(schema, compiled);
  }
  return compiled;
}

/**
 * `z.compile` on the contract's own schemas, here and nowhere else.
 * A clone: anything keyed by schema identity uses the shared original.
 */
function routeOptions(binding: AnyBinding) {
  const { entry } = binding;
  const response: Record<number, z.ZodType> = {};
  for (const { status } of refusalsOf(binding))
    response[status] = compiledEnvelope(refusalEnvelopeOf(entry, status));
  for (const [status, schema] of rawRefusalsOf(binding))
    response[status] = z.compile(schema);
  response[entry.status] = z.compile(successSchemaOf(entry));

  return {
    binding,
    ...(entry.bodyKind !== 'json' && { parse: 'none' as const }),
    ...(entry.params && { params: z.compile(entry.params) }),
    ...(entry.query && { query: z.compile(entry.query) }),
    ...(entry.bodyKind === 'json' &&
      entry.body && { body: z.compile(entry.body) }),
    response,
    detail: {
      summary: binding.options.detail.summary,
      ...(binding.options.detail.description && {
        description: binding.options.detail.description,
      }),
      tags: [...binding.options.detail.tags],
    },
  };
}

/** The raw bodies a handler answers at a refusal status, each validated like its success. */
const rawRefusalsOf = ({ entry }: AnyBinding): [number, z.ZodType][] =>
  isRawResponse(entry.response)
    ? Object.entries(entry.response.refusals ?? {}).map(
        ([status, schema]): [number, z.ZodType] => [Number(status), schema]
      )
    : [];

interface BindingContext {
  request: Request;
  params: unknown;
  query: unknown;
  body: unknown;
  set: { headers: Record<string, string | number | string[] | undefined> };
}

export function registerBinding(app: GatedApp, binding: AnyBinding): void {
  const { entry } = binding;
  const options = routeOptions(binding);
  const valued = new Set([
    entry.status,
    ...rawRefusalsOf(binding).map(([status]) => status),
  ]);

  const answer = async (context: BindingContext) => {
    const answered = await runBinding(binding, context.request, context);
    // Any other status is a refusal already shaped by core, which the
    // framework must send as it is.
    if (!valued.has(answered.status)) return toWebResponse(answered);
    return answerValue(context.request, context.set, answered);
  };

  app.method(entry.method, entry.path, options, answer);
  // The GET's own registration: the exit step drops the body.
  if (entry.method === 'GET') app.method('HEAD', entry.path, options, answer);
}

const REQUIRED_HOOKS = ['error', 'mapResponse', 'afterResponse'] as const;

/**
 * Elysia copies the hooks a route can see when it is registered, so a route
 * added before them would answer unmapped and unlogged. The boot
 * stops instead.
 */
export function assertEveryRouteHooked(app: GatedApp): void {
  const unhooked = app.routes
    // The CORS plugin's preflight routes, registered ahead of the exit step on
    // purpose: a preflight keeps only the headers CORS gives it.
    .filter((route) => route.method !== 'OPTIONS')
    .filter((route) =>
      REQUIRED_HOOKS.some((name) => {
        const hooks: unknown = route.hooks?.[name];
        return !Array.isArray(hooks) || hooks.length === 0;
      })
    )
    .map((route) => `${route.method} ${route.path}`);
  if (unhooked.length > 0)
    throw new Error(
      `Registered before the hooks, so unmapped and unlogged: ${unhooked.join(', ')}`
    );
}
