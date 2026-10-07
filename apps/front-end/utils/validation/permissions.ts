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

/**
 * The empty form, shared by the create page and the edit page — the edit page
 * needs it too, so that a record missing an optional field still gives every
 * input a value and React never switches one from uncontrolled to controlled.
 */
export const DEFAULT_PERMISSION: DefaultValues<CreatePermissionInput> = {
  roleName: '',
  description: '',
  isActive: true,
  permissions: [],
};

/**
 * A stored record as the edit form's `values`: exactly the update body's
 * fields, since that schema is strict and the id travels in the path. Explicit
 * per field so every input has a value from its first render — spreading the
 * record would leave an absent optional field `undefined` and make React switch
 * it to controlled on the first keystroke.
 */
export const toPermissionForm = (
  record: PermissionClient
): UpdatePermissionInput => ({
  roleName: record.roleName,
  description: record.description ?? '',
  isActive: record.isActive,
  permissions: record.permissions,
});
