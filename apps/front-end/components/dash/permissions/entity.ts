import {
  createPermission,
  deletePermission,
  getPermission,
  listPermissions,
  updatePermission,
} from '@app/shared/api/permissions';

import { defineEntity } from '../shared/entity';

export const permissionEntity = defineEntity({
  scope: 'permissions',
  endpoints: {
    list: listPermissions,
    create: createPermission,
    get: getPermission,
    update: updatePermission,
    remove: deletePermission,
  },
  route: '/dash/permissions',
  noun: 'الصلاحية',
  resource: 'permissions',
});

/** The user form's role picker: active roles only, scoped to the viewer. */
export const ROLE_OPTIONS_KEY = ['roles'];
export { listRoles as ROLE_OPTIONS } from '@app/shared/api/users';
