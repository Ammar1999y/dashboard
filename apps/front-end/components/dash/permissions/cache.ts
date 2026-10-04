import type {
  PagePermission,
  PermissionClient,
  RoleSummary,
} from '@/types/permission';
import type { UserClient } from '@/types/user';
import type { EntityID } from '@app/shared/types';
import type { QueryClient } from '@tanstack/react-query';

import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import { cacheUpdatedEach } from '@/lib/api/query-cache';

import { userEntity } from '../users/entity';
import { permissionEntity, ROLE_OPTIONS_KEY } from './entity';

/**
 * Keeps the role picker's list in step with a saved permission: an active one
 * is listed (renamed in place, or appended as the newest), an inactive one is
 * not.
 */
export function cacheRoleOption(
  queryClient: QueryClient,
  role: RoleSummary & { isActive: boolean }
) {
  const option: RoleSummary = { id: role.id, roleName: role.roleName };

  queryClient.setQueryData<RoleSummary[]>(ROLE_OPTIONS_KEY, (roles) => {
    if (!roles) return roles;
    if (!role.isActive) return roles.filter((r) => r.id !== role.id);
    if (roles.some((r) => r.id === role.id)) {
      return roles.map((r) => (r.id === role.id ? option : r));
    }
    return [...roles, option];
  });
}

export function removeRoleOption(queryClient: QueryClient, id: EntityID) {
  queryClient.setQueryData<RoleSummary[]>(ROLE_OPTIONS_KEY, (roles) =>
    roles?.filter((r) => r.id !== id)
  );
}

/**
 * The `{ id, roleName }` a user row embeds for `roleId`, or `undefined` when
 * the client cannot know it — a new custom role (its id is the server's), or a
 * role the picker's list does not hold, since that list is scoped to the
 * viewer. `undefined` leaves a cached row's role as it is.
 */
export function resolveUserRole(
  queryClient: QueryClient,
  roleId: UserClient['roleId'],
  current?: UserClient
): UserClient['role'] | undefined {
  if (!roleId) return null;
  if (current && roleId === current.roleId) return current.role;
  if (roleId === CUSTOM_ROLE_VALUE) return undefined;
  const roles = queryClient.getQueryData<RoleSummary[]>(ROLE_OPTIONS_KEY);
  return roles?.find((r) => r.id === roleId);
}

/**
 * Users embed their role's name, and a user's detail its role's matrix, so a
 * rename or a new matrix is written into their rows.
 */
export function cacheRoleChanged(
  queryClient: QueryClient,
  id: EntityID,
  {
    roleName,
    permissions,
  }: { roleName: string; permissions?: PagePermission[] }
) {
  cacheUpdatedEach<UserClient>(queryClient, userEntity.keys, (user) => {
    if (user.role?.id !== id) return user;
    const renamed = user.role.roleName !== roleName;
    const regranted = !!permissions && !!user.permissions;
    if (!renamed && !regranted) return user;
    return {
      ...user,
      role: { ...user.role, roleName },
      ...(regranted && { permissions }),
    };
  });
}

/** A standard role's matrix, when this client holds the role's detail. */
export function cachedRoleMatrix(
  queryClient: QueryClient,
  roleId: UserClient['roleId']
): PagePermission[] | undefined {
  if (!roleId || roleId === CUSTOM_ROLE_VALUE) return undefined;
  return queryClient.getQueryData<PermissionClient>(
    permissionEntity.keys.detail(roleId)
  )?.permissions;
}

/**
 * A user joined (`delta` 1) or left (-1) a role: its row's count follows. A
 * custom role is no row of the list, and a detail carries no count.
 */
export function cacheRoleUsersCount(
  queryClient: QueryClient,
  roleId: UserClient['roleId'] | undefined,
  delta: number
) {
  if (!roleId || roleId === CUSTOM_ROLE_VALUE) return;
  cacheUpdatedEach<PermissionClient>(
    queryClient,
    permissionEntity.keys,
    (role) =>
      role.id === roleId && role.usersCount !== undefined
        ? { ...role, usersCount: Math.max(0, role.usersCount + delta) }
        : role
  );
}
