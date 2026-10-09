import type { RouteManifestEntry } from '../route-manifest';
import type { JsonSchema } from './json-schema';

import { BETTER_AUTH_BODIES, REQUEST_BODIES } from '@app/shared/contract';
import {
  BETTER_AUTH_RESPONSES,
  isResponseRoute,
  PAGINATED_ROUTES,
  RESPONSE_DATA,
} from '@app/shared/response-contract';

import {
  BETTER_AUTH_ALLOWED_PATH_SET,
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_KNOWN_PATHS,
  betterAuthServes,
} from '@/lib/auth/allowed-paths';

import { compareCodeUnits } from '@/utils/text';

import { isSafeMethod } from '../origin';
import { isDevelopmentOnlyPath } from '../route-manifest';
import {
  betterAuthDocumentPath,
  generatedBetterAuthOperation,
  generatedBetterAuthResponse,
  LIBRARY_VERIFIER_PATHS,
} from './better-auth';
import {
  BETTER_AUTH_PATH_STATUSES,
  BETTER_AUTH_SUMMARIES,
  BETTER_AUTH_TRUSTED_RESPONSES,
} from './better-auth-tables';
import { COMPONENT_SCHEMAS } from './components';
import { isJsonSchema } from './json-schema';
import { MULTIPART_BODIES, OTP_SEND_ROUTES } from './request-bodies';
import {
  operationKey,
  tableOperation,
  toOpenApiPath,
} from './route-operations';
import {
  BODY_SCHEMA_REFUSALS,
  BODYLESS_BAD_REQUEST_ROUTES,
  CHANNEL_UNAVAILABLE_ROUTES,
  CONFLICT_ROUTES,
  CREATED_ROUTES,
  ID_NOT_FOUND_ROUTES,
  MEDIA_REFUSAL_CODES,
  MEDIA_REFUSALS_WITHOUT_IDS,
  NOT_FOUND_ROUTES,
  OPERATION_DOCS,
  QUERY_VALIDATION_ROUTES,
  SESSION_COOKIE_ROUTES,
} from './route-tables';
import { RESPONSE_COMPONENTS, successContract } from './success-schemas';

/** Every table keyed `METHOD path`, in the order its leftovers are reported. */
const ROUTE_KEYED_TABLES: readonly (readonly [string, Iterable<string>])[] = [
  ['REQUEST_BODIES', Object.keys(REQUEST_BODIES)],
  ['MULTIPART_BODIES', Object.keys(MULTIPART_BODIES)],
  ['CREATED_ROUTES', CREATED_ROUTES],
  ['CONFLICT_ROUTES', CONFLICT_ROUTES],
  ['BODYLESS_BAD_REQUEST_ROUTES', BODYLESS_BAD_REQUEST_ROUTES],
  ['NOT_FOUND_ROUTES', NOT_FOUND_ROUTES],
  ['ID_NOT_FOUND_ROUTES', ID_NOT_FOUND_ROUTES],
  ['BODY_SCHEMA_REFUSALS', Object.keys(BODY_SCHEMA_REFUSALS)],
  ['QUERY_VALIDATION_ROUTES', QUERY_VALIDATION_ROUTES],
  ['CHANNEL_UNAVAILABLE_ROUTES', CHANNEL_UNAVAILABLE_ROUTES],
  ['SESSION_COOKIE_ROUTES', SESSION_COOKIE_ROUTES],
  ['OTP_SEND_ROUTES', OTP_SEND_ROUTES],
  ['OPERATION_DOCS', Object.keys(OPERATION_DOCS)],
  ['RESPONSE_DATA', Object.keys(RESPONSE_DATA)],
  ['PAGINATED_ROUTES', PAGINATED_ROUTES],
  ['MEDIA_REFUSAL_CODES', Object.keys(MEDIA_REFUSAL_CODES)],
  ['MEDIA_REFUSALS_WITHOUT_IDS', MEDIA_REFUSALS_WITHOUT_IDS],
];

/** Methods in a stable order, so one collision reads the same on every run. */
const methodList = (methods: Iterable<string>): string =>
  [...methods].toSorted(compareCodeUnits).join(', ');

export function openApiConsistencyProblems(
  manifest: readonly RouteManifestEntry[],
  withheld: readonly RouteManifestEntry[] = []
): string[] {
  const problems: string[] = [];
  const keys = new Set(manifest.map(operationKey));
  const withheldKeys = new Set(withheld.map(operationKey));

  for (const entry of manifest) {
    const key = operationKey(entry);
    if (!(key in OPERATION_DOCS))
      problems.push(`${key} has no OPERATION_DOCS entry`);
    if (entry.response === 'envelope' && !isResponseRoute(key))
      problems.push(
        `${key} answers the envelope but has no RESPONSE_DATA entry`
      );
    if (entry.response !== 'envelope' && isResponseRoute(key))
      problems.push(
        `${key} has a RESPONSE_DATA entry but answers '${entry.response}'`
      );
    // The key is what types the handler's answers, so a row wired to another
    // route's handler would publish one contract and serve another.
    if (entry.handlerKey !== undefined && entry.handlerKey !== key)
      problems.push(
        `${key} is served by the handler keyed '${entry.handlerKey}'`
      );
    if (entry.response === 'envelope' && entry.handlerKey === undefined)
      problems.push(
        `${key} answers the envelope but its handler is not keyed, so nothing checks what it returns`
      );
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
    if (ID_NOT_FOUND_ROUTES.has(key) && !entry.path.includes(':'))
      problems.push(`${key} is in ID_NOT_FOUND_ROUTES but has no path id`);
    if (ID_NOT_FOUND_ROUTES.has(key) && !NOT_FOUND_ROUTES.has(key))
      problems.push(
        `${key} is in ID_NOT_FOUND_ROUTES but not in NOT_FOUND_ROUTES, so the 404 it answers is unpublished`
      );
    if (entry.body !== 'json' && key in BODY_SCHEMA_REFUSALS)
      problems.push(
        `${key} has a BODY_SCHEMA_REFUSALS entry but declares body: '${entry.body}'`
      );

    // `toElysiaHandler` answers these ahead of every handler. An envelope row
    // without its contract has no operation to build; it is reported above.
    if (
      key in OPERATION_DOCS &&
      (entry.response !== 'envelope' || isResponseRoute(key))
    ) {
      const { responses } = tableOperation(entry).operation;
      const adapterStatuses = [
        ...(isSafeMethod(entry.method) ? [] : ['403']),
        ...(entry.preAuth === 'ip-limit' ? ['429', '503'] : []),
      ];
      for (const status of adapterStatuses)
        if (!isJsonSchema(responses) || !(status in responses))
          problems.push(
            `${key} does not publish the ${status} its adapter answers`
          );
      const coded = Object.keys(MEDIA_REFUSAL_CODES[key] ?? {});
      for (const status of coded)
        if (!isJsonSchema(responses) || !(status in responses))
          problems.push(
            `${key} lists media codes under ${status}, which it does not publish`
          );
    }
  }

  // A key for a route the production filter or a switched-off feature
  // withholds is not a leftover: the route exists, it is only unpublished.
  const isLeftover = (key: string): boolean =>
    !keys.has(key) &&
    !withheldKeys.has(key) &&
    !isDevelopmentOnlyPath(key.slice(key.indexOf(' ') + 1));

  for (const [table, tableKeys] of ROUTE_KEYED_TABLES)
    for (const key of tableKeys)
      if (isLeftover(key))
        problems.push(`${table} has '${key}', which is not a route`);

  for (const keywords of successContract().unusedKeywords)
    problems.push(
      `DOCUMENT_KEYWORDS has ${keywords}, which no converted response reaches`
    );

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
        // Only an attested library 200 is read from the generated schema.
        for (const status of [
          ...(BETTER_AUTH_TRUSTED_RESPONSES.has(endpoint.path) ? ['200'] : []),
          '400',
          '404',
          '500',
        ])
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
  problems.push(...successSourceProblems(BETTER_AUTH_KNOWN_PATHS));

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

/** Where a Better Auth path's 200 comes from; exactly one of these names it. */
export const SUCCESS_SOURCES: readonly (readonly [
  string,
  ReadonlySet<string>,
])[] = [
  ['BETTER_AUTH_RESPONSES', new Set(Object.keys(BETTER_AUTH_RESPONSES))],
  ['LIBRARY_VERIFIER_RESPONSES', LIBRARY_VERIFIER_PATHS],
  ['BETTER_AUTH_TRUSTED_RESPONSES', BETTER_AUTH_TRUSTED_RESPONSES],
];

/**
 * Every Better Auth path, under every configuration, takes its 200 from exactly
 * one source, and no source names a path that does not exist. Two sources would
 * publish one body and check another.
 */
export function successSourceProblems(
  paths: ReadonlySet<string>,
  sources = SUCCESS_SOURCES
): string[] {
  const problems: string[] = [];
  for (const path of paths) {
    const named = sources
      .filter(([, keys]) => keys.has(path))
      .map(([name]) => name);
    if (named.length === 0)
      problems.push(
        `Better Auth ${path} takes its 200 from no source: give it a BETTER_AUTH_RESPONSES entry, or attest the library's in BETTER_AUTH_TRUSTED_RESPONSES`
      );
    else if (named.length > 1)
      problems.push(
        `Better Auth ${path} takes its 200 from ${named.join(' and ')}; it must come from exactly one`
      );
  }
  for (const [name, keys] of sources)
    for (const key of keys)
      if (!paths.has(key))
        problems.push(
          `${name} has '${key}', which is not a Better Auth endpoint`
        );
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
  const projectNames = new Set<string>([
    ...Object.keys(COMPONENT_SCHEMAS),
    ...RESPONSE_COMPONENTS.map(({ name }) => name),
  ]);
  return Object.keys(betterAuthSchemas)
    .filter((name) => projectNames.has(name))
    .map(
      (name) =>
        `components.schemas '${name}' is defined by this project AND by Better Auth; the merge would keep only the second, under every $ref this document emits`
    );
}

export function assertConsistent(problems: readonly string[]): void {
  if (problems.length > 0)
    throw new Error(
      `OpenAPI document is inconsistent with the route table:\n  ${problems.join('\n  ')}`
    );
}
