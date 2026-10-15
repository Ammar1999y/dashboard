import { defineEntity } from '../shared/entity';

export const permissionEntity = defineEntity({
  scope: 'permissions',
  api: '/api/dash/permissions',
  route: '/dash/permissions',
  noun: 'الصلاحية',
  resource: 'permissions',
});

/** The user form's role picker: active roles only, scoped to the viewer. */
export const ROLE_OPTIONS_KEY = ['roles'];
export const ROLE_OPTIONS_HREF = '/api/dash/roles';
