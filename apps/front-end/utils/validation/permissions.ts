import type { PermissionClient } from '@/types/permission';
import type { DefaultValues } from 'react-hook-form';
import type * as z from 'zod';

import { createPermissionSchema } from '@app/shared/validation/permissions';

import { idSchema } from './rules';

export {
  createPermissionSchema,
  permissionsArraySchema,
} from '@app/shared/validation/permissions';

/** The edit form's resolver. `id` stays in the form; the request sends it in the path. */
export const updatePermissionSchema = createPermissionSchema
  .extend({ id: idSchema })
  .partial({ permissions: true });

export type CreatePermissionInput = z.input<typeof createPermissionSchema>;
export type UpdatePermissionInput = z.input<typeof updatePermissionSchema>;
export type CreatePermissionOutput = z.output<typeof createPermissionSchema>;
export type UpdatePermissionOutput = z.output<typeof updatePermissionSchema>;

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
  id: record.id,
  roleName: record.roleName ?? '',
  description: record.description ?? '',
  isActive: record.isActive ?? true,
  permissions: record.permissions,
});
