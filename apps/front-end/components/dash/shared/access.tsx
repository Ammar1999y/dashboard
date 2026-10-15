import type {
  AllScopedAction,
  DashboardPage,
  PermissionAction,
} from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';
import type { ReactNode } from 'react';

import { useMemo } from 'react';

import { CustomError } from '@app/shared/error-class';
import { HTTP_STATUS } from '@app/shared/http-status';
import { MSG_INSUFFICIENT_PERMISSIONS } from '@app/shared/messages/permissions';
import {
  holdsActionOn,
  resolveActionScope,
} from '@app/shared/permissions/scope';
import { useGrants } from '@/lib/grants';

import { ErrorState } from '@/components/ui/error-state';

const FORBIDDEN = new CustomError(
  MSG_INSUFFICIENT_PERMISSIONS,
  HTTP_STATUS.FORBIDDEN
);

/**
 * What the signed-in user may be offered on a dashboard page, from the grants
 * on their session. The server decides: a stale grant hides an action or
 * offers one it then refuses, never the reverse. Without a `resource` there is
 * nothing to gate on, as for an entity whose page has no grants yet.
 *
 * `can` is any scope, for what is offered before a record is in hand. `holds`
 * is one record: an `own` grant reaches only what the user created, and
 * anything else the server answers as not found.
 */
export function useResourceAccess(resource: DashboardPage | undefined) {
  const { userId, roleId, permissions } = useGrants();
  return useMemo(
    () => ({
      userId,
      roleId,
      can: (action: PermissionAction) =>
        !resource || resolveActionScope(permissions, resource, action).allowed,
      holds: (action: AllScopedAction, createdBy: EntityID | null) =>
        !resource ||
        holdsActionOn(permissions, resource, action, createdBy, userId),
    }),
    [permissions, resource, roleId, userId]
  );
}

/** The page of an action the user cannot perform, reached by its link. */
export const ForbiddenState = () => <ErrorState error={FORBIDDEN} />;

interface RequireGrantProps {
  resource: DashboardPage;
  action: PermissionAction;
  children: ReactNode;
}

/** `children` for a user who holds `action` on `resource`, in any scope. */
export function RequireGrant({
  resource,
  action,
  children,
}: RequireGrantProps) {
  const { can } = useResourceAccess(resource);
  return can(action) ? children : <ForbiddenState />;
}
