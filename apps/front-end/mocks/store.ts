import type { CategoryClient } from '@/types/categories';
import type { PermissionClient } from '@/types/permission';
import type { ProjectClient } from '@/types/projects';
import type { SectionClient } from '@/types/sections';
import type { SettingsClient } from '@/types/settings';
import type { UserClient } from '@/types/user';

import { generateUUIDv7 } from '@/utils';
import { CUSTOM_ROLE_VALUE, ROLE_SCOPE } from '@/lib/permissions/constants';

import { singleton, table } from './lib/db';
import {
  CUSTOM_ROLE_NAME,
  seedCategories,
  seedProjects,
  seedRoles,
  seedSections,
  seedSettings,
  seedUsers,
} from './seed';

export interface MockUser extends UserClient {
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
export const roles = table<PermissionClient>('roles', seedRoles);
export const categories = table<CategoryClient>('categories', seedCategories);
export const projects = table<ProjectClient>('projects', seedProjects);
export const sections = table<SectionClient>('sections', seedSections);
export const settings = singleton<SettingsClient | null>(
  'settings',
  seedSettings
);
export const session = singleton<MockSession | null>('session', () => null);

export const toUserClient = ({ password: _, ...user }: MockUser): UserClient =>
  user;

/**
 * The `role` a user row embeds. A custom pick mints its own role, as the server
 * does; `undefined` means the id names no assignable role.
 */
export function userRole(
  roleId: UserClient['roleId'],
  current?: UserClient['role']
): UserClient['role'] | undefined {
  if (!roleId) return null;
  if (roleId === CUSTOM_ROLE_VALUE) {
    return current?.scope === ROLE_SCOPE.CUSTOM
      ? current
      : {
          id: generateUUIDv7(),
          roleName: CUSTOM_ROLE_NAME,
          scope: ROLE_SCOPE.CUSTOM,
        };
  }
  const role = roles.find(roleId);
  if (!role || role.scope !== ROLE_SCOPE.STANDARD) return undefined;
  return { id: role.id, roleName: role.roleName, scope: role.scope };
}
