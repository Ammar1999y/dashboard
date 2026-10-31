import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';

import { listRoles } from '@app/shared/api/users';
import { MSG_FETCH_ERROR, MSG_FETCHED } from '@app/shared/messages/common';

import { bind } from '@/lib/http/binding';
import { standardScopeFilter } from '@/lib/permissions/roles';
import { actorCoversTargetRole } from '@/lib/users/target-user';

export const listRolesBinding = bind(listRoles, {
  permission: { resource: 'permissions', action: 'view' },
  rateLimit: { scope: 'roles.get', limit: 30, by: 'user' },
  failure: MSG_FETCH_ERROR,
  detail: {
    summary: 'List assignable roles',
    description:
      'The active standard roles a user create or edit by the caller accepts: those whose every grant the caller also holds. Under `permissions.viewOwn`, only the roles the caller created.',
    tags: ['Permissions'],
  },
  handler: async ({ actor }) => {
    const { userId, scope, permissions } = actor;

    const activeRoles = await db.query.roles.findMany({
      where: and(
        eq(roles.isActive, true),
        standardScopeFilter(),
        scope === 'own' ? eq(roles.createdBy, userId) : undefined
      ),
      columns: { id: true, roleName: true },
      with: {
        rolePermissions: { columns: { pageName: true, permissions: true } },
      },
      orderBy: [asc(roles.createdAt), asc(roles.id)],
      limit: 1000,
    });

    return {
      message: MSG_FETCHED,
      data: activeRoles
        .filter((role) =>
          actorCoversTargetRole(permissions, role.rolePermissions)
        )
        .map(({ id, roleName }) => ({ id, roleName })),
    };
  },
});
