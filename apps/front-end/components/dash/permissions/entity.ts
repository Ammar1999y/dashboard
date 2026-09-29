import type { EntityID } from '@/types';

import { defineEntity } from '../shared/entity';

export const permissionEntity = defineEntity({
  scope: 'permissions',
  api: '/api/dash/permissions',
  route: '/dash/permissions',
  noun: 'الصلاحية',
});

/** A role as the user form's picker lists it: active ones only, scoped to the viewer. */
export interface RoleOption {
  id: EntityID;
  roleName: string;
}

export const ROLE_OPTIONS_KEY = ['roles'];
export const ROLE_OPTIONS_HREF = '/api/dash/roles';
