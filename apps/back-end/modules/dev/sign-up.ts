import { withTransaction } from '@/db';

import { devSignUp } from '@app/shared/api/dev';
import { MSG_CREATE_ERROR, MSG_CREATED } from '@app/shared/messages/common';

import { hashPassword } from '@/lib/auth/password/hash';
import { bind } from '@/lib/http/binding';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { insertSystemUser } from '@/lib/users/system-user';

/**
 * ⚠️ No environment gate here, deliberately: `registeredBindings`
 * (`modules/index.ts`) leaves every `/api/dev/*` binding unregistered outside
 * development, so this is never reached there. It matters, because this mints
 * a `ROLE_SCOPE.SYSTEM` role holding every permission from an unauthenticated
 * request.
 */
export const devSignUpBinding = bind(devSignUp, {
  preAuthIpLimit: false,
  failure: MSG_CREATE_ERROR,
  mapError: handleUserUniqueViolation,
  detail: {
    summary: 'Create a development system user',
    tags: ['Development'],
  },
  handler: async ({ body: { name, email, password } }) => {
    const passwordHash = await hashPassword(password);
    const { userId } = await withTransaction((tx) =>
      insertSystemUser(tx, { name, email, passwordHash })
    );
    return { message: MSG_CREATED, data: { id: userId } };
  },
});
