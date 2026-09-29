import type { RouteManifestEntry } from '../route-manifest';
import type { JsonSchema } from './json-schema';

import { BETTER_AUTH_BODIES, REQUEST_BODIES } from '@app/shared/contract';

import {
  BETTER_AUTH_ALLOWED_PATH_SET,
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_KNOWN_PATHS,
  betterAuthServes,
} from '@/lib/auth/allowed-paths';

import { compareCodeUnits } from '@/utils/text';

import { isDevelopmentOnlyPath } from '../route-manifest';
import {
  betterAuthDocumentPath,
  generatedBetterAuthOperation,
  generatedBetterAuthResponse,
} from './better-auth';
import {
  BETTER_AUTH_PATH_STATUSES,
  BETTER_AUTH_SUMMARIES,
} from './better-auth-tables';
import { COMPONENT_SCHEMAS } from './components';
import { MULTIPART_BODIES, OTP_SEND_ROUTES } from './request-bodies';
import { operationKey, toOpenApiPath } from './route-operations';
import {
  BODYLESS_BAD_REQUEST_ROUTES,
  CHANNEL_UNAVAILABLE_ROUTES,
  CONFLICT_ROUTES,
  CREATED_ROUTES,
  NOT_FOUND_ROUTES,
  OPERATION_DOCS,
  PAGINATED_SUCCESS_ROUTES,
  QUERY_VALIDATION_ROUTES,
  SESSION_COOKIE_ROUTES,
} from './route-tables';
import { SUCCESS_DATA_SCHEMAS } from './success-schemas';

/** Every table keyed `METHOD path`, in the order its leftovers are reported. */
const ROUTE_KEYED_TABLES: readonly (readonly [string, Iterable<string>])[] = [
  ['REQUEST_BODIES', Object.keys(REQUEST_BODIES)],
  ['MULTIPART_BODIES', Object.keys(MULTIPART_BODIES)],
  ['CREATED_ROUTES', CREATED_ROUTES],
  ['CONFLICT_ROUTES', CONFLICT_ROUTES],
  ['BODYLESS_BAD_REQUEST_ROUTES', BODYLESS_BAD_REQUEST_ROUTES],
  ['NOT_FOUND_ROUTES', NOT_FOUND_ROUTES],
  ['QUERY_VALIDATION_ROUTES', QUERY_VALIDATION_ROUTES],
  ['CHANNEL_UNAVAILABLE_ROUTES', CHANNEL_UNAVAILABLE_ROUTES],
  ['SESSION_COOKIE_ROUTES', SESSION_COOKIE_ROUTES],
  ['OTP_SEND_ROUTES', OTP_SEND_ROUTES],
  ['OPERATION_DOCS', Object.keys(OPERATION_DOCS)],
  ['SUCCESS_DATA_SCHEMAS', Object.keys(SUCCESS_DATA_SCHEMAS)],
  ['PAGINATED_SUCCESS_ROUTES', PAGINATED_SUCCESS_ROUTES],
];

/** Methods in a stable order, so one collision reads the same on every run. */
const methodList = (methods: Iterable<string>): string =>
  [...methods].toSorted(compareCodeUnits).join(', ');

export function openApiConsistencyProblems(
  manifest: readonly RouteManifestEntry[]
): string[] {
  const problems: string[] = [];
  const keys = new Set(manifest.map(operationKey));

  for (const entry of manifest) {
    const key = operationKey(entry);
    if (!(key in OPERATION_DOCS))
      problems.push(`${key} has no OPERATION_DOCS entry`);
    if (entry.response === 'envelope' && !(key in SUCCESS_DATA_SCHEMAS))
      problems.push(`${key} has no concrete success data schema`);
    if (entry.body === 'json' && !(key in REQUEST_BODIES))
      problems.push(
        `${key} declares body: 'json' but has no REQUEST_BODIES entry`
      );
    if (entry.body !== 'json' && key in REQUEST_BODIES)
      problems.push(
        `${key} has a REQUEST_BODIES entry but declares body: '${entry.body}'`
      );
    if (entry.body === 'multipart' && !(key in MULTIPART_BODIES))
      problems.push(
        `${key} declares body: 'multipart' but has no MULTIPART_BODIES entry`
      );
    if (entry.body !== 'multipart' && key in MULTIPART_BODIES)
      problems.push(
        `${key} has a MULTIPART_BODIES entry but declares body: '${entry.body}'`
      );
  }

  // A key for a route the production filter withholds is not a leftover: the
  // route exists, it is only unpublished.
  const isLeftover = (key: string): boolean =>
    !keys.has(key) && !isDevelopmentOnlyPath(key.slice(key.indexOf(' ') + 1));

  for (const [table, tableKeys] of ROUTE_KEYED_TABLES)
    for (const key of tableKeys)
      if (isLeftover(key))
        problems.push(`${table} has '${key}', which is not a route`);

  // Existence is checked against the paths servable under ANY configuration —
  // a method flag can switch most of these off — and the method only where the
  // current configuration serves the path.
  for (const key of Object.keys(BETTER_AUTH_BODIES)) {
    if (!BETTER_AUTH_KNOWN_PATHS.has(key))
      problems.push(
        `BETTER_AUTH_BODIES has '${key}', which is not a Better Auth endpoint`
      );
    else if (
      BETTER_AUTH_ALLOWED_PATH_SET.has(key) &&
      !betterAuthServes(key, 'POST')
    )
      problems.push(
        `BETTER_AUTH_BODIES has '${key}', which is served but not under POST`
      );
  }
  for (const key of Object.keys(BETTER_AUTH_PATH_STATUSES))
    if (!BETTER_AUTH_KNOWN_PATHS.has(key))
      problems.push(
        `BETTER_AUTH_PATH_STATUSES has '${key}', which is not a Better Auth endpoint`
      );

  for (const endpoint of BETTER_AUTH_ENDPOINTS)
    for (const method of endpoint.methods) {
      if (!(`${method} ${endpoint.path}` in BETTER_AUTH_SUMMARIES))
        problems.push(
          `Better Auth ${method} ${endpoint.path} has no summary entry`
        );
      const operation = generatedBetterAuthOperation(endpoint.path, method);
      if (operation) {
        for (const status of ['200', '400', '404', '500'])
          if (!generatedBetterAuthResponse(endpoint.path, method, status))
            problems.push(
              `Better Auth's generated schema has no ${status} response for ${method} ${endpoint.path}`
            );
      } else
        problems.push(
          `Better Auth's generated schema has no ${method} ${endpoint.path}`
        );
    }

  for (const key of Object.keys(BETTER_AUTH_SUMMARIES)) {
    const path = key.slice(key.indexOf(' ') + 1);
    if (!BETTER_AUTH_KNOWN_PATHS.has(path))
      problems.push(
        `BETTER_AUTH_SUMMARIES has '${key}', which is not a Better Auth endpoint`
      );
  }

  // The Better Auth producer ASSIGNS a whole path item after the table routes
  // merge theirs per method, so a shared PATH loses the table's operations
  // whatever the methods. Needed until that assignment becomes a merge.
  const tablePaths = new Map<string, Set<string>>();
  for (const entry of manifest) {
    const { path } = toOpenApiPath(entry.path);
    const methods = tablePaths.get(path) ?? new Set<string>();
    methods.add(entry.method);
    tablePaths.set(path, methods);
  }
  for (const endpoint of BETTER_AUTH_ENDPOINTS) {
    const full = betterAuthDocumentPath(endpoint.path);
    const claimed = tablePaths.get(full);
    if (claimed)
      problems.push(
        `${full} is declared by the route table (${methodList(claimed)}) AND by the Better Auth prefix (${methodList(endpoint.methods)}); the Better Auth loop replaces the whole path item, so the table's operations would be absent from the document`
      );
  }

  return problems;
}

/**
 * `referencedBetterAuthSchemas` spreads last into `components.schemas`, so a
 * Better Auth schema sharing a project schema's name would replace it under
 * every `$ref` this document emits. Checked against the referenced subset only:
 * an unreferenced name merges into nothing, and failing on it would turn an
 * unrelated library upgrade into an outage.
 */
export function schemaCollisionProblems(
  betterAuthSchemas: JsonSchema
): string[] {
  return Object.keys(betterAuthSchemas)
    .filter((name) => name in COMPONENT_SCHEMAS)
    .map(
      (name) =>
        `components.schemas '${name}' is defined by COMPONENT_SCHEMAS AND by Better Auth; the merge would keep only the second, under every $ref this document emits`
    );
}

export function assertConsistent(problems: readonly string[]): void {
  if (problems.length > 0)
    throw new Error(
      `OpenAPI document is inconsistent with the route table:\n  ${problems.join('\n  ')}`
    );
}
