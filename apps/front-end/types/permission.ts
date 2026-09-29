import type { EntityID } from '.';
import type {
  DashboardPage,
  PermissionAction,
  ROLE_SCOPE,
} from '@app/shared/permissions/constants';

export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE];

export interface PagePermission {
  name: DashboardPage;
  permissions: Partial<Record<PermissionAction, boolean>>;
}

export interface PermissionClient {
  id: EntityID;
  roleName: string;
  description?: string | null;
  isActive: boolean;
  scope: RoleScope;
  usersCount?: number;
  createdAt?: string; // timestamp with time zone in Postgres
  updatedAt?: string; // timestamp with time zone in Postgres
  permissions: PagePermission[];
}
