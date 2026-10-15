import { dataTableQuerySchema } from '../data-table/query';
import {
  createdIdSchema,
  noDataSchema,
  paginationMetaSchema,
  updatedAtSchema,
} from '../responses/common';
import {
  permissionDetailSchema,
  permissionRowsSchema,
} from '../responses/permissions';
import {
  adminUpdatePermissionBodySchema,
  createPermissionSchema,
} from '../validation/permissions';
import { GRANTED, idParams } from './common';
import { endpoint } from './endpoint';

export const listPermissions = endpoint({
  method: 'GET',
  path: '/api/dash/permissions',
  query: dataTableQuerySchema,
  status: 200,
  response: { data: permissionRowsSchema, meta: paginationMetaSchema },
  policy: { ...GRANTED, reauth: false },
});

/**
 * Lenient on unknown top-level keys, so a client may post back a listed row.
 * 400 for a role name in the reserved custom-role namespace.
 */
export const createPermission = endpoint({
  method: 'POST',
  path: '/api/dash/permissions',
  body: createPermissionSchema,
  status: 201,
  response: createdIdSchema,
  errors: { 400: {}, 409: {} },
  policy: { ...GRANTED, reauth: true },
});

export const getPermission = endpoint({
  method: 'GET',
  path: '/api/dash/permissions/:id',
  params: idParams,
  status: 200,
  response: permissionDetailSchema,
  errors: { 404: {} },
  policy: { ...GRANTED, reauth: false },
});

/** 400 for a role name in the reserved custom-role namespace. */
export const updatePermission = endpoint({
  method: 'PUT',
  path: '/api/dash/permissions/:id',
  params: idParams,
  body: adminUpdatePermissionBodySchema,
  status: 200,
  response: updatedAtSchema,
  errors: { 400: {}, 404: {}, 409: {} },
  policy: { ...GRANTED, reauth: true },
});

/** 400 while live users still hold the role. */
export const deletePermission = endpoint({
  method: 'DELETE',
  path: '/api/dash/permissions/:id',
  params: idParams,
  status: 200,
  response: noDataSchema,
  errors: { 400: {}, 404: {} },
  policy: { ...GRANTED, reauth: true },
});
