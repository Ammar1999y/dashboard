import type { RoleScope } from '@/lib/permissions/constants';

import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import { EntityID } from '.';
import { PagePermission } from './permission';

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
