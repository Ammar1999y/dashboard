import {
  storageReadySchema,
  storageUnauthorizedSchema,
  storageUnavailableSchema,
} from '../responses/health';
import { storageHealthQuerySchema } from '../validation/health';
import { endpoint } from './endpoint';

/**
 * The deployment's readiness probe. Every answer the handler gives is raw,
 * because the deployed check reads `status` at the top level; the whole route
 * requires the maintenance token, which the server checks before anything else.
 */
export const getStorageHealth = endpoint({
  method: 'GET',
  path: '/api/health/storage',
  query: storageHealthQuerySchema,
  status: 200,
  response: {
    raw: storageReadySchema,
    refusals: { 401: storageUnauthorizedSchema, 503: storageUnavailableSchema },
  },
  policy: {
    auth: 'public',
    captcha: false,
    reauth: false,
    rateLimited: false,
    checksPassword: false,
  },
});
