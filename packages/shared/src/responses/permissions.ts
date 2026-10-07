import * as z from 'zod';

import { DASHBOARD_PAGE_NAMES } from '../permissions/constants';
import { permissionSchema } from '../validation/permissions';
import { dateTime, uuid } from './common';

const permissionRowSchema = z.object({
  id: uuid(),
  roleName: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: dateTime(),
  updatedAt: dateTime(),
  usersCount: z.number().int().nonnegative(),
});

export const permissionRowsSchema = z.array(permissionRowSchema);

export const roleSummarySchema = z.object({
  id: uuid(),
  roleName: z.string(),
});

export const roleSummariesSchema = z.array(roleSummarySchema);

// A plain object, not the request's `.strict()` one: an action added between
// deploys is dropped by an older client rather than failing the whole matrix.
const pagePermissionSchema = z.object({
  name: z.enum(DASHBOARD_PAGE_NAMES),
  permissions: z.object(permissionSchema.shape),
});

export const permissionMatrixSchema = z.array(pagePermissionSchema);

export const permissionDetailSchema = z.object({
  id: uuid(),
  roleName: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  permissions: permissionMatrixSchema,
});
