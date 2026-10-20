/**
 * The document `GET /openapi.json` serves: generated once, on its first
 * request or by `prepareServedDocument`, then frozen for the life of the
 * process with its serialised body. The generator reads the framework's
 * routes, so the framework layer provides it once the application exists
 * (`server/elysia/openapi.ts`); nothing here builds it.
 */
import type { OpenApiDocument } from '@app/shared/responses/openapi';

import { getOpenApiDocument } from '@app/shared/api/openapi';

import { errorClassOf, logLine } from '@/utils/log';

import { SerializedJson } from '../response';

const source: {
  generate?: () => Promise<OpenApiDocument>;
  document?: Promise<OpenApiDocument>;
  body?: Promise<SerializedJson<typeof getOpenApiDocument.response.raw>>;
} = {};

export function provideDocument(
  generate: () => Promise<OpenApiDocument>
): void {
  if (source.generate)
    throw new Error('The served OpenAPI document already has a source.');
  source.generate = generate;
}

/**
 * A failed generation is kept and rethrown: it is deterministic, and retrying
 * would repeat its cost on every authorised request.
 */
export function servedDocument(): Promise<OpenApiDocument> {
  if (!source.generate)
    throw new Error('Nothing provides the served OpenAPI document.');
  source.document ??= source.generate();
  return source.document;
}

/** The served document as the bytes the route sends, serialised once. */
export function servedDocumentBody(): Promise<
  SerializedJson<typeof getOpenApiDocument.response.raw>
> {
  source.body ??= servedDocument().then((document) =>
    SerializedJson.of(getOpenApiDocument.response.raw, document)
  );
  return source.body;
}

/**
 * Generates the document now, so no request pays for it: the generation is one
 * synchronous block of a few hundred milliseconds. A failure is logged here
 * and answered as before, by the route that asks.
 */
export function prepareServedDocument(): void {
  const started = performance.now();
  void servedDocumentBody()
    .then(() => {
      logLine('log', {
        msg: 'openapi document prepared',
        durationMs: Math.round(performance.now() - started),
      });
    })
    .catch((error: unknown) => {
      logLine('error', {
        msg: 'openapi document generation failed',
        errorClass: errorClassOf(error),
      });
    });
}
