import { defineEntity } from '../shared/entity';

export const userEntity = defineEntity({
  scope: 'dash-users',
  api: '/api/dash/users',
  route: '/dash/users',
  noun: 'المستخدم',
  resource: 'users',
});
