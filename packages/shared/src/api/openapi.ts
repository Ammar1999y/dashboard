import { openApiDocumentSchema } from '../responses/openapi';
import { endpoint } from './endpoint';

/**
 * Any dashboard view grant unlocks the document, which is a contextual check
 * the handler makes after the gate's session: 403 without one.
 */
export const getOpenApiDocument = endpoint({
  method: 'GET',
  path: '/openapi.json',
  status: 200,
  response: { raw: openApiDocumentSchema },
  errors: { 403: {} },
  policy: {
    auth: 'session',
    captcha: false,
    reauth: false,
    rateLimited: false,
    checksPassword: false,
  },
});
