import { getOpenApiDocument } from '@app/shared/api/openapi';
import { MSG_INTERNAL_ERROR } from '@app/shared/messages/common';

import { bind } from '@/lib/http/binding';
import { servedDocumentBody } from '@/lib/http/openapi/serve';
import { requireDashboardAccess } from '@/lib/http/session';

/**
 * The document maps every path, method and parameter this server serves, so
 * it is for dashboard users only: any view grant, read from the database.
 * The refusal comes before the document is touched, so a refused caller costs
 * the gate and one grant read.
 */
export const openApiDocumentBinding = bind(getOpenApiDocument, {
  failure: MSG_INTERNAL_ERROR,
  detail: {
    summary: 'Get this API contract',
    tags: ['Contract'],
    responses: { 200: 'The OpenAPI 3.1 contract for this deployment.' },
  },
  handler: async ({ actor, meta }) => {
    await requireDashboardAccess(meta, actor);
    return { raw: await servedDocumentBody() };
  },
});
