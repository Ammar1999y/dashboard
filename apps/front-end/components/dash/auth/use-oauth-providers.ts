import { authCapabilities } from '@app/shared/api/better-auth';
import { useEndpointQuery } from '@/lib/api/query';

import { providersSchema } from './schemas';

/** The providers this deployment signs in with; the server decides, and may offer none. */
export const useOAuthProviders = () =>
  useEndpointQuery(authCapabilities, undefined, {
    queryKey: ['auth', 'capabilities'],
    narrow: providersSchema,
  });
