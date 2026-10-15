import { useAuthQuery } from '@/lib/auth/query';

import { providersSchema } from './schemas';

/** The providers this deployment signs in with; the server decides, and may offer none. */
export const useOAuthProviders = () =>
  useAuthQuery({
    queryKey: ['auth', 'capabilities'],
    path: '/capabilities',
    schema: providersSchema,
  });
