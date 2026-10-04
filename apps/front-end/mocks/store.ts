import type { CategoryClient } from '@/types/categories';
import type { PagePermission } from '@/types/permission';
import type { ProjectClient } from '@/types/projects';
import type { SectionClient } from '@/types/sections';
import type { SettingsClient } from '@/types/settings';
import type { UserClient } from '@/types/user';
import type { EntityID } from '@app/shared/types';

import { ROLE_SCOPE } from '@app/shared/permissions/constants';

import { singleton, table } from './lib/db';
import {
  seedCategories,
  seedProjects,
  seedRoles,
  seedSections,
  seedSettings,
  seedUsers,
} from './seed';

export { roleRef } from './seed';

// The rows as the server stores them. Handlers answer with the API types, which
// leave out what the server keeps to itself (a role's scope, a password).

type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE];

export interface MockRole {
  id: EntityID;
  roleName: string;
  description: string | null;
  isActive: boolean;
  scope: RoleScope;
  permissions: PagePermission[];
  createdBy: EntityID | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A custom role exists only here, embedded in its one user, so this carries
 * what the server's `roles` row would for it.
 */
export interface MockUserRole {
  id: EntityID;
  roleName: string;
  scope: RoleScope;
  createdBy: EntityID | null;
}

export interface MockUser extends Omit<UserClient, 'role'> {
  role: MockUserRole | null;
  createdBy: EntityID | null;
  password: string;
}

export interface MockSession {
  session: {
    id: string;
    token: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: null;
    createdAt: string;
    updatedAt: string;
  };
}

export const users = table<MockUser>('users', seedUsers);
export const roles = table<MockRole>('roles', seedRoles);
export const categories = table<CategoryClient>('categories', seedCategories);
export const projects = table<ProjectClient>('projects', seedProjects);
export const sections = table<SectionClient>('sections', seedSections);
export const settings = singleton<SettingsClient | null>(
  'settings',
  seedSettings
);
export const session = singleton<MockSession | null>('session', () => null);

export const toUserClient = ({
  password: _,
  createdBy: __,
  role,
  ...user
}: MockUser): UserClient => ({
  ...user,
  role: role && { id: role.id, roleName: role.roleName },
});

/** The signed-in user's row, or `undefined` once the account is gone. */
export const currentUser = () => {
  const id = session.get()?.user.id;
  return id ? users.find(id) : undefined;
};

/** What the server's `roles` row says of a user's role; `undefined` without one. */
export function roleOf(
  user: MockUser
): { isActive: boolean; permissions: PagePermission[] } | undefined {
  if (user.role?.scope === ROLE_SCOPE.CUSTOM)
    return { isActive: true, permissions: user.permissions ?? [] };
  return user.roleId ? roles.find(user.roleId) : undefined;
}
