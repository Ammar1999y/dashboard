import type { EntityID } from '.';
import type { PagePermission } from './permission';
import type { CUSTOM_ROLE_VALUE, RoleScope } from '@/lib/permissions/constants';

interface UserRole {
  id: EntityID;
  roleName: string;
  scope?: RoleScope;
}

export interface UserClient {
  id: EntityID;
  name: string;
  email: string;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  isActive: boolean;
  roleId: EntityID | typeof CUSTOM_ROLE_VALUE | null;
  role: UserRole | null;
  createdAt?: string; // timestamp with time zone in Postgres
  updatedAt?: string; // timestamp with time zone in Postgres
  permissions?: PagePermission[];
}
