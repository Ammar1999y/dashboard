/**
 * `createAuthEndpoint` keyed by its path in `BETTER_AUTH_RESPONSES`: the
 * handler's answers are typed as that path's published 2xx body. The runtime
 * check at the prefix route holds the same body to the same schema.
 */
import type { REDIRECTING_PLUGIN_PATHS } from '@/lib/http/openapi/better-auth-tables';
import type {
  BetterAuthResponse,
  BetterAuthResponseRoute,
} from '@app/shared/response-contract';
import type { AuthContext } from '@better-auth/core';
import type { APIError, EndpointContext, EndpointOptions } from 'better-call';

import { createAuthEndpoint } from 'better-auth/api';

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

/** What a handler keyed `P` may return: its body, or a redirect where `P` sends one. */
export type PluginAnswer<P extends BetterAuthResponseRoute> =
  | ServerValue<BetterAuthResponse<P>>
  | (P extends RedirectingRoute ? APIError : never);

export function pluginEndpoint<
  P extends BetterAuthResponseRoute,
  O extends EndpointOptions,
>(
  path: P,
  options: O,
  handler: (ctx: EndpointContext<P, O, AuthContext>) => Promise<PluginAnswer<P>>
) {
  return createAuthEndpoint(path, options, handler);
}
