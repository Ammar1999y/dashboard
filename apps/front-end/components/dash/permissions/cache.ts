import type { RoleOption } from './entity';
import type { EntityID } from '@/types';
import type { UserClient } from '@/types/user';
import type { QueryClient } from '@tanstack/react-query';

import { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';

import { cacheUpdatedEach } from '@/utils/query-cache';

import { userEntity } from '../users/entity';
import { ROLE_OPTIONS_KEY } from './entity';

/**
 * Keeps the role picker's list in step with a saved permission: an active one
 * is listed (renamed in place, or appended as the newest), an inactive one is
 * not.
 */
export function cacheRoleOption(
  queryClient: QueryClient,
  role: RoleOption & { isActive: boolean }
) {
  const option: RoleOption = { id: role.id, roleName: role.roleName };

  queryClient.setQueryData<RoleOption[]>(ROLE_OPTIONS_KEY, (roles) => {
    if (!roles) return roles;
    if (!role.isActive) return roles.filter((r) => r.id !== role.id);
    if (roles.some((r) => r.id === role.id)) {
      return roles.map((r) => (r.id === role.id ? option : r));
    }
    return [...roles, option];
  });
}

export function removeRoleOption(queryClient: QueryClient, id: EntityID) {
  queryClient.setQueryData<RoleOption[]>(ROLE_OPTIONS_KEY, (roles) =>
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
  const roles = queryClient.getQueryData<RoleOption[]>(ROLE_OPTIONS_KEY);
  return roles?.find((r) => r.id === roleId);
}

/** Users embed their role's name, so a rename is written into their rows. */
export function cacheRoleRenamed(
  queryClient: QueryClient,
  id: EntityID,
  roleName: string
) {
  cacheUpdatedEach<UserClient>(queryClient, userEntity.keys, (user) =>
    user.role?.id === id && user.role.roleName !== roleName
      ? { ...user, role: { ...user.role, roleName } }
      : user
  );
}
