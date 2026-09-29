import { withTransaction } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';
import { devSignUpSchema } from '@app/shared/validation/dev';

import { insertCredentialAccount } from '@/lib/auth/credential-account';
import { hashPassword } from '@/lib/auth/password/hash';
import { handleUserUniqueViolation } from '@/lib/http/constraint-errors';
import { readJsonBody } from '@/lib/http/input';
import { apiSuccess, withApiErrors } from '@/lib/http/response';

/**
 * ⚠️ No environment gate here, deliberately: `toRegisteredRoutes`
 * (`lib/http/route-manifest.ts`) leaves every `/api/dev/*` entry unregistered
 * outside development, so this is never reached there. It matters, because
 * this mints a `ROLE_SCOPE.SYSTEM` role holding every permission from an
 * unauthenticated request.
 */
export const POST = withApiErrors(
  MSG_CREATE_ERROR,
  async (ctx) => {
    const { name, email, password } = await readJsonBody(ctx, devSignUpSchema);
    const hashedPassword = await hashPassword(password);

    const newId = await withTransaction(async (tx) => {
      const [systemRole] = await tx
        .insert(roles)
        .values({
          roleName: `system-${email}`,
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

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  },
  handleUserUniqueViolation
);
