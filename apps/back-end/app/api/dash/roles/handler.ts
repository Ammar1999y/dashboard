import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';

import { MSG_FETCH_ERROR, MSG_FETCHED } from '@app/shared/api-messages';
import { ROLE_SCOPE } from '@app/shared/permissions/constants';

import { apiSuccess, withApiErrors } from '@/lib/http/response';
import { requirePermission } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

export const GET = withApiErrors(MSG_FETCH_ERROR, async (ctx) => {
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
        eq(roles.scope, ROLE_SCOPE.STANDARD),
        scope === 'own' ? eq(roles.createdBy, userId) : undefined
      )
    )
    .orderBy(asc(roles.createdAt), asc(roles.id))
    .limit(1000);

  return apiSuccess({ message: MSG_FETCHED, data: activeRoles });
});
