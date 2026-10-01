import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Handler } from '../contract';
import type { RouteManifestEntry } from '../route-manifest';
import type { JsonSchema } from './json-schema';

import { apiRaw } from '../response';
import { requireDashboardAccess } from '../session';
import { openApiDocument } from './document';
import { isJsonSchema } from './json-schema';

/**
 * Where `scripts/build-openapi.ts` writes the document, relative to the
 * back-end root. Under `build/`, which is git-ignored and served by nothing:
 * the document maps the whole reachable surface, so it stays behind the same
 * authorisation as the routes.
 */
export const OPENAPI_ARTIFACT_PATH = 'build/openapi.json';

export function openApiArtifactFile(): string {
  return path.resolve(import.meta.dir, '..', '..', '..', OPENAPI_ARTIFACT_PATH);
}

/**
 * Wraps a manifest getter in a build-once cache; a build failure is cached and
 * rethrown too.
 *
 * Separate from the handler because the handler checks access first, which
 * makes the memoisation unobservable through it without a session.
 * `getManifest` stays lazy: `routes.ts` calls the handler factory while
 * `ROUTES` is still being built.
 */
export function memoiseOpenApiDocument(
  getManifest: () => readonly RouteManifestEntry[],
  getWithheld: () => readonly RouteManifestEntry[] = () => []
): () => JsonSchema {
  let built: { document: JsonSchema } | { error: unknown } | null = null;

  return () => {
    built ??= (() => {
      try {
        return { document: openApiDocument(getManifest(), getWithheld()) };
      } catch (error) {
        return { error };
      }
    })();

    if ('error' in built) throw built.error;
    return built.document;
  };
}

function prebuiltDocument(): JsonSchema | null {
  const file = openApiArtifactFile();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from this module's own location, never from input
  if (!existsSync(file)) return null;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isJsonSchema(parsed))
    throw new Error(`${OPENAPI_ARTIFACT_PATH} is not a JSON object.`);
  return parsed;
}

/**
 * Outside production the artefact is never read: one left behind by an earlier
 * build would otherwise hide every later route and schema edit.
 */
export function resolveOpenApiDocument(
  readPrebuilt: () => JsonSchema | null,
  generate: () => JsonSchema,
  production = process.env.NODE_ENV === 'production'
): JsonSchema {
  if (!production) return generate();
  const prebuilt = readPrebuilt();
  if (prebuilt) return prebuilt;
  throw new Error(`${OPENAPI_ARTIFACT_PATH} is required in production.`);
}

/**
 * The route that serves the document, resolved once and then frozen: the
 * manifest is static for the life of the process, and generating it is costly
 * enough to matter on a route with no admission gate.
 *
 * Takes a getter so this module imports nothing from `routes.ts`, and so the
 * table can pass its own manifest before `ROUTES` exists.
 *
 * `apiRaw`, not the envelope: an OpenAPI document's top-level shape is fixed by
 * the spec.
 */
export function openApiRouteHandler(
  getManifest: () => readonly RouteManifestEntry[],
  getWithheld: () => readonly RouteManifestEntry[] = () => []
): Handler {
  const generate = memoiseOpenApiDocument(getManifest, getWithheld);
  let resolved: JsonSchema | null = null;

  return async (ctx) => {
    // The document maps every path, method and parameter this server serves,
    // so it is for dashboard users only — and checked before the document is
    // resolved, so a refused caller costs a session lookup and nothing else.
    await requireDashboardAccess(ctx);

    resolved ??= resolveOpenApiDocument(prebuiltDocument, generate);
    return apiRaw({ body: resolved });
  };
}
