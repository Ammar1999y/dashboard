import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
} from '@app/shared/api/users';

import { defineEntity } from '../shared/entity';

export const userEntity = defineEntity({
  scope: 'dash-users',
  endpoints: {
    list: listUsers,
    create: createUser,
    get: getUser,
    update: updateUser,
    remove: deleteUser,
  },
  route: '/dash/users',
  noun: 'المستخدم',
  resource: 'users',
});
