import { withTransaction } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';

import { devSignUp } from '@app/shared/api/dev';
import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_CREATE_ERROR, MSG_CREATED } from '@app/shared/messages/common';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';

import { insertCredentialAccount } from '@/lib/auth/credential-account';
import { hashPassword } from '@/lib/auth/password/hash';
import { bind } from '@/lib/http/binding';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { generateUuidV7 } from '@/lib/id';

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
    const hashedPassword = await hashPassword(password);
    // Named by the user's id, not the email: the role is inserted first, so an
    // email clash would surface as the role name's, which no mapping answers 409.
    const userId = generateUuidV7();

    const newId = await withTransaction(async (tx) => {
      const [systemRole] = await tx
        .insert(roles)
        .values({
          roleName: `system-${userId}`,
          scope: ROLE_SCOPE.SYSTEM,
          isActive: true,
        })
        .returning({ id: roles.id });

      if (!systemRole)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      const allPermissions = DEFAULT_PAGE_PERMISSIONS.map((page) => ({
        roleId: systemRole.id,
        pageName: page.name,
        permissions: Object.fromEntries(
          page.availablePermissions.map((action) => [action, true])
        ),
      }));

      await tx.insert(rolePermissions).values(allPermissions);

      const [newUser] = await tx
        .insert(users)
        .values({
          id: userId,
          name,
          email,
          roleId: systemRole.id,
          isActive: true,
        })
        .returning({ id: users.id });

      if (!newUser)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      await insertCredentialAccount(tx, newUser.id, hashedPassword);

      return newUser.id;
    });

    return { message: MSG_CREATED, data: { id: newId } };
  },
});
