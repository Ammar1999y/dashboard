import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';

import { listRoles } from '@app/shared/api/users';
import { MSG_FETCH_ERROR, MSG_FETCHED } from '@app/shared/messages/common';

import { bind } from '@/lib/http/binding';
import { standardScopeFilter } from '@/lib/permissions/roles';

export const listRolesBinding = bind(listRoles, {
  permission: { resource: 'permissions', action: 'view' },
  rateLimit: { scope: 'roles.get', limit: 30, by: 'user' },
  failure: MSG_FETCH_ERROR,
  detail: { summary: 'List assignable roles', tags: ['Permissions'] },
  handler: async ({ actor }) => {
    const { userId, scope } = actor;

    const activeRoles = await db
      .select({
        id: roles.id,
        roleName: roles.roleName,
      })
      .from(roles)
      .where(
        and(
          eq(roles.isActive, true),
          standardScopeFilter(),
          scope === 'own' ? eq(roles.createdBy, userId) : undefined
        )
      )
      .orderBy(asc(roles.createdAt), asc(roles.id))
      .limit(1000);

    return { message: MSG_FETCHED, data: activeRoles };
  },
});
