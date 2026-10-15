import { createPermissionBinding, listPermissionsBinding } from './collection';
import {
  deletePermissionBinding,
  getPermissionBinding,
  updatePermissionBinding,
} from './item';

export const PERMISSION_BINDINGS = [
  listPermissionsBinding,
  createPermissionBinding,
  getPermissionBinding,
  updatePermissionBinding,
  deletePermissionBinding,
];
