/**
 * `createAuthEndpoint` built from a plugin endpoint's shared entry: the path
 * and method come from the entry, and the handler's answers are typed as its
 * published 2xx body. The runtime check at the prefix route holds the same
 * body to the same schema.
 */
import type { REDIRECTING_PLUGIN_PATHS } from '@/lib/http/openapi/better-auth-tables';
import type { PluginEndpoint, PluginPath } from '@app/shared/api/all';
import type { AuthContext } from '@better-auth/core';
import type { APIError, EndpointContext, EndpointOptions } from 'better-call';
import type * as z from 'zod';

import { createAuthEndpoint } from 'better-auth/api';

import { pluginPathOf } from '@app/shared/api/all';

/**
 * What a handler may hand the serialiser where the wire carries `T`: a `Date`
 * wherever `T` is a plain `string`, because `Response.json` writes it as one.
 * Literal and enum strings keep their exact type.
 */
type ServerValue<T> = T extends string
  ? string extends T
    ? T | Date
    : T
  : T extends readonly (infer Element)[]
    ? readonly ServerValue<Element>[]
    : T extends object
      ? { [K in keyof T]: ServerValue<T[K]> }
      : T;

type RedirectingRoute = (typeof REDIRECTING_PLUGIN_PATHS)[number];

/** What a handler of `E` may return: its body, or a redirect where it sends one. */
export type PluginAnswer<E extends PluginEndpoint> =
  | ServerValue<z.output<E['response']['raw']>>
  | (PluginPath<E['path']> extends RedirectingRoute ? APIError : never);

// `Extract` lets the compiler see a generic `O` plus a method as endpoint options.
type Options<E extends PluginEndpoint, O> = Extract<
  O & { method: E['method'] },
  EndpointOptions
>;

export function pluginEndpoint<
  E extends PluginEndpoint,
  O extends Omit<EndpointOptions, 'method'>,
>(
  entry: E,
  options: O,
  handler: (
    ctx: EndpointContext<PluginPath<E['path']>, Options<E, O>, AuthContext>
  ) => Promise<PluginAnswer<E>>
) {
  const endpointOptions = { ...options, method: entry.method } as Options<E, O>;
  return createAuthEndpoint(
    pluginPathOf<E['path']>(entry.path),
    endpointOptions,
    handler
  );
}
