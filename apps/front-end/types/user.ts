import type { PagePermission, RoleSummary } from './permission';
import type { CUSTOM_ROLE_VALUE } from '@app/shared/permissions/constants';
import type { EntityID } from '@app/shared/types';

/**
 * A user as `/api/dash/users` sends it. The verification flags, the phone and
 * the effective permissions come with the detail only.
 */
export interface UserClient {
  id: EntityID;
  name: string;
  email: string;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  isActive: boolean;
  roleId: EntityID | typeof CUSTOM_ROLE_VALUE | null;
  role: RoleSummary | null;
  createdAt: string;
  updatedAt: string;
  permissions?: PagePermission[];
}
