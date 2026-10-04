import type { EntityID } from '@app/shared/types';
import type { pagePermissionSchema } from '@app/shared/validation/permissions';
import type * as z from 'zod';

export type PagePermission = z.output<typeof pagePermissionSchema>;

/** A role as a user record and the role picker carry it. */
export interface RoleSummary {
  id: EntityID;
  roleName: string;
}

/**
 * A role as `/api/dash/permissions` sends it. The list carries the counts and
 * timestamps; the detail carries the matrix.
 */
export interface PermissionClient {
  id: EntityID;
  roleName: string;
  description: string | null;
  isActive: boolean;
  usersCount?: number;
  createdAt?: string;
  updatedAt?: string;
  permissions?: PagePermission[];
}
