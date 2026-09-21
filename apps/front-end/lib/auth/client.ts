import { createAuthClient } from 'better-auth/react';
import { API_URL } from '@/lib/env';

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: 'include',
  },
});

/** TODO
import type { auth } from '../auth';

import { inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields<typeof auth>({
      user: {
        captcha: {
          type: 'string',
        },
      },
    }),
  ],
});

export type Session = typeof authClient.$Infer.Session;
 * 
 *  */
