/**
 * Every endpoint entry, for the server's checks over all of them. A client
 * imports the entry it calls instead: this pulls in every schema.
 */
import type { AnyEndpoint, RawResponse } from './endpoint';

import * as auth from './auth';
import * as betterAuth from './better-auth';
import * as dev from './dev';
import { BETTER_AUTH_PREFIX } from './endpoint';
import * as health from './health';
import * as media from './media';
import * as openapi from './openapi';
import * as permissions from './permissions';
import * as users from './users';

/** Every entry the server binds. */
export const ENDPOINTS: readonly AnyEndpoint[] = [
  permissions,
  users,
  media,
  auth,
  dev,
  health,
  openapi,
].flatMap((domain): AnyEndpoint[] => Object.values(domain));

export type PluginEndpoint = (typeof betterAuth)[keyof typeof betterAuth];

/** `/api/auth/two-factor/disable` → `/two-factor/disable`, as Better Auth routes it. */
export type PluginPath<P extends string = PluginEndpoint['path']> =
  P extends `${typeof BETTER_AUTH_PREFIX}${infer Path}` ? Path : never;

/** A plugin endpoint's path under the prefix, which Better Auth routes by. */
export const pluginPathOf = <P extends string>(path: P): PluginPath<P> => {
  if (!path.startsWith(`${BETTER_AUTH_PREFIX}/`))
    throw new Error(`${path} is not under ${BETTER_AUTH_PREFIX}`);
  return path.slice(BETTER_AUTH_PREFIX.length) as PluginPath<P>;
};

/** Any plugin endpoint, for code that handles every one alike. */
export type AnyPluginEndpoint = AnyEndpoint & {
  readonly response: RawResponse;
};

/** Every plugin endpoint, keyed by its path under the prefix. */
export const PLUGIN_ENDPOINTS: ReadonlyMap<string, AnyPluginEndpoint> = new Map(
  Object.values(betterAuth).map((entry) => [pluginPathOf(entry.path), entry])
);

export const isPluginPath = (path: string): path is PluginPath =>
  PLUGIN_ENDPOINTS.has(path);
