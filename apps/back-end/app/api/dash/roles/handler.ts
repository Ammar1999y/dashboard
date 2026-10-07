import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';

import { MSG_FETCH_ERROR, MSG_FETCHED } from '@app/shared/messages/common';

import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { standardScopeFilter } from '@/lib/permissions/roles';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(
  'GET /api/dash/roles',
  MSG_FETCH_ERROR,
  async (ctx) => {
    const { userId, scope } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'roles.get',
      identifier: userIdentifier(userId),
      limit: 30,
    });

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

    return apiSuccess({ message: MSG_FETCHED, data: activeRoles });
  }
);
