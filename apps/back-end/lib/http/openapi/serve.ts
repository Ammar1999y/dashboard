/**
 * The document `GET /openapi.json` serves: generated on its first request,
 * then frozen for the life of the process. The generator reads the
 * framework's routes, so the framework layer provides it once the application
 * exists (`server/elysia/openapi.ts`); nothing here builds it.
 */
import type { OpenApiDocument } from '@app/shared/responses/openapi';

const source: {
  generate?: () => Promise<OpenApiDocument>;
  document?: Promise<OpenApiDocument>;
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
