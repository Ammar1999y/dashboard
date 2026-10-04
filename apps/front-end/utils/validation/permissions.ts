import type { PermissionClient } from '@/types/permission';
import type {
  adminUpdatePermissionBodySchema,
  createPermissionSchema,
} from '@app/shared/validation/permissions';
import type { DefaultValues } from 'react-hook-form';
import type * as z from 'zod';

export type CreatePermissionInput = z.input<typeof createPermissionSchema>;
export type UpdatePermissionInput = z.input<
  typeof adminUpdatePermissionBodySchema
>;
export type CreatePermissionOutput = z.output<typeof createPermissionSchema>;
export type UpdatePermissionOutput = z.output<
  typeof adminUpdatePermissionBodySchema
>;

/** See the note on DEFAULT_CATEGORY in ./categories. */
export const DEFAULT_PERMISSION: DefaultValues<CreatePermissionInput> = {
  roleName: '',
  description: '',
  isActive: true,
  permissions: [],
};

/** See the note on toCategoryForm in ./categories. */
export const toPermissionForm = (
  record: PermissionClient
): UpdatePermissionInput => ({
  roleName: record.roleName,
  description: record.description ?? '',
  isActive: record.isActive,
  permissions: record.permissions,
});
