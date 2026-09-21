import type { EntityID } from '.';
import type {
  DashboardPage,
  PermissionAction,
  RoleScope,
} from '@/lib/permissions/constants';

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
