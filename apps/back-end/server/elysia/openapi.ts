/**
 * The document Elysia generates from the registered bindings, finished in
 * core and served by `GET /openapi.json`; and, in development only, the
 * Scalar page that renders it.
 */
import type { GatedApp } from '@/app';
import type { AnyBinding } from '@/lib/http/binding';
import type { RouteShape } from '@/lib/http/routing';
import type { OpenApiDocument } from '@app/shared/responses/openapi';
import type { AnyElysia } from 'elysia';

import packageManifest from '@/package.json';
import { toOpenAPISchema } from '@elysia/openapi/openapi';
import { ScalarRender } from '@elysia/openapi/scalar';

import { OPENAPI_VERSION } from '@app/shared/responses/openapi';

import { loadFieldDocs } from '@/lib/http/openapi/docs';
import { finalizeDocument } from '@/lib/http/openapi/finalize';
import { mergeBetterAuth } from '@/lib/http/openapi/merge-better-auth';
import { provideDocument } from '@/lib/http/openapi/serve';
import { enforcePreAuthIpLimit } from '@/lib/http/pre-auth';
import { handleApiError, toWebResponse } from '@/lib/http/response';
import { referencePageCsp } from '@/lib/http/security-headers';

import { exemptFromCsp } from './respond';

export async function generateDocument(
  app: AnyElysia,
  bindings: readonly AnyBinding[]
): Promise<OpenApiDocument> {
  // First: the prose attaches to the shared schema instances, which the
  // compiled route schemas share by reference.
  await loadFieldDocs();
  const generated = toOpenAPISchema(
    app,
    // HEAD routes mirror their GET and OPTIONS is the CORS layer's. A
    // `staticFile` exclusion would drop `GET /openapi.json`.
    { methods: ['options', 'head'], staticFile: false },
    undefined,
    undefined,
    OPENAPI_VERSION
  );
  return finalizeDocument(generated, bindings, await mergeBetterAuth());
}

/** The served document is `app`'s own, generated on its first request. */
export function serveDocument(
  app: AnyElysia,
  bindings: readonly AnyBinding[]
): void {
  provideDocument(() => generateDocument(app, bindings));
}

/**
 * jsDelivr serves a published file of an npm version unchanged, so its hash
 * holds; a `.min.js` the package does not publish is minified on request, and
 * jsDelivr warns against SRI on those. A new version needs a new hash.
 */
const SCALAR_VERSION = '1.72.1';
const SCALAR_ORIGIN = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/`;
const SCALAR_SCRIPT = `${SCALAR_ORIGIN}dist/browser/standalone.js`;
const SCALAR_INTEGRITY =
  'sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK';

/** The page's place in routing, beside the bindings', so it answers 405, 308, HEAD and OPTIONS as they do. */
export const REFERENCE_PAGE_ROUTE: RouteShape = {
  method: 'GET',
  path: '/openapi',
  body: 'none',
};

/**
 * `ScalarRender` writes the script tag itself and takes no integrity, so the
 * attribute goes into the tag it wrote; a template that no longer writes that
 * tag stops the boot rather than loading the script unchecked.
 */
function withIntegrity(html: string): string {
  const tag = `<script src="${SCALAR_SCRIPT}" crossorigin>`;
  if (html.split(tag).length !== 2)
    throw new Error(
      'The reference page no longer writes the Scalar script tag once.'
    );
  return html.replace(
    tag,
    () =>
      `<script src="${SCALAR_SCRIPT}" integrity="${SCALAR_INTEGRITY}" crossorigin>`
  );
}

/**
 * The page fetches `/openapi.json` with the browser's own session, so it
 * shows nothing to a caller the document route refuses. Its own route only:
 * the plugin would also mount an ungated document of its own.
 *
 * ⚠️ One of only two registrations outside `bind()`, beside the Better Auth
 * prefix (`auth-mount.ts`): an HTML page cannot be a contract entry. Do not
 * copy it for an API route. It still joins routing (`REFERENCE_PAGE_ROUTE`)
 * and takes the per-IP admission limit and HEAD every binding takes.
 */
export function mountReferencePage(app: GatedApp): void {
  const page = withIntegrity(
    ScalarRender(
      {
        title: 'Dashboard API',
        description: 'The development reference for this server.',
        version: packageManifest.version,
      },
      {
        url: '/openapi.json',
        cdn: SCALAR_SCRIPT,
        withDefaultFonts: false,
        telemetry: false,
      }
    )
  );
  const csp = referencePageCsp(SCALAR_ORIGIN);
  const { method, path } = REFERENCE_PAGE_ROUTE;
  const config = { detail: { hide: true } } as const;
  const handler = async ({ request }: { request: Request }) => {
    try {
      await enforcePreAuthIpLimit({
        apiPath: path,
        headers: request.headers,
      });
    } catch (error) {
      return toWebResponse(handleApiError(error));
    }
    exemptFromCsp(request, csp);
    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  app.method(method, path, config, handler);
  app.method('HEAD', path, config, handler);
}
