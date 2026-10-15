import * as z from 'zod';

export const OPENAPI_VERSION = '3.1.1';

/** The members every document this server generates carries; the rest passes through. */
export const openApiDocumentSchema = z.looseObject({
  openapi: z.literal(OPENAPI_VERSION),
  info: z.record(z.string(), z.unknown()),
  servers: z.array(z.unknown()),
  tags: z.array(z.unknown()),
  components: z.record(z.string(), z.unknown()),
  paths: z.record(z.string(), z.unknown()),
});

export type OpenApiDocument = z.input<typeof openApiDocumentSchema>;
