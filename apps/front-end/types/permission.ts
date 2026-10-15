import type {
  permissionDetailSchema,
  permissionMatrixSchema,
  permissionRowsSchema,
  roleSummarySchema,
} from '@app/shared/responses/permissions';
import type * as z from 'zod';

export type PagePermission = z.output<typeof permissionMatrixSchema>[number];

export type RoleSummary = z.output<typeof roleSummarySchema>;

type PermissionRow = z.output<typeof permissionRowsSchema>[number];

export type PermissionDetail = z.output<typeof permissionDetailSchema>;

/**
 * A role as the cache holds it: a list row and a detail share one entity's
 * keys, so each carries the fields only it has as optional.
 */
export type PermissionClient = Pick<
  PermissionDetail,
  'id' | 'roleName' | 'description' | 'isActive'
> &
  Partial<PermissionRow> &
  Partial<PermissionDetail>;
