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
  getManifest: () => readonly RouteManifestEntry[]
): () => JsonSchema {
  let built: { document: JsonSchema } | { error: unknown } | null = null;

  return () => {
    built ??= (() => {
      try {
        return { document: openApiDocument(getManifest()) };
      } catch (error) {
        return { error };
      }
    })();

    if ('error' in built) throw built.error;
    return built.document;
  };
}

/**
 * The build artefact, or `null` when there is none — normal in development and
 * under test, where regenerating from the live table makes an edit visible
 * without a build step.
 */
function prebuiltDocument(): JsonSchema | null {
  const file = path.resolve(
    import.meta.dir,
    '..',
    '..',
    '..',
    OPENAPI_ARTIFACT_PATH
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from this module's own location, never from input
  if (!existsSync(file)) return null;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isJsonSchema(parsed))
    throw new Error(`${OPENAPI_ARTIFACT_PATH} is not a JSON object.`);
  return parsed;
}

export function resolveOpenApiDocument(
  prebuilt: JsonSchema | null,
  generate: () => JsonSchema,
  production = process.env.NODE_ENV === 'production'
): JsonSchema {
  if (prebuilt) return prebuilt;
  if (production)
    throw new Error(`${OPENAPI_ARTIFACT_PATH} is required in production.`);
  return generate();
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
  getManifest: () => readonly RouteManifestEntry[]
): Handler {
  const generate = memoiseOpenApiDocument(getManifest);
  // Not `??=` on the document: "no artefact" is a legitimate resolution, and a
  // nullish assignment would re-stat the filesystem on every request.
  let resolved: { document: JsonSchema } | null = null;

  return async (ctx) => {
    // The document maps every path, method and parameter this server serves,
    // so it is for dashboard users only — and checked before the document is
    // resolved, so a refused caller costs a session lookup and nothing else.
    await requireDashboardAccess(ctx);

    resolved ??= {
      document: resolveOpenApiDocument(prebuiltDocument(), generate),
    };
    return apiRaw({ body: resolved.document });
  };
}
