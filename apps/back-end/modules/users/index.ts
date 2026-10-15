import { createUserBinding, listUsersBinding } from './collection';
import {
  changeEmailBinding,
  changePhoneBinding,
  verifyEmailChangeBinding,
  verifyPhoneChangeBinding,
} from './contact-change';
import { deleteUserBinding, getUserBinding, updateUserBinding } from './item';
import {
  changePasswordBinding,
  getPreferencesBinding,
  updatePreferencesBinding,
  updateSelfBinding,
} from './me';
import { listRolesBinding } from './roles';
import { listUserSessionsBinding, revokeUserSessionsBinding } from './sessions';
import { resetUserTwoFactorBinding } from './two-factor';

export const USER_BINDINGS = [
  listRolesBinding,
  updateSelfBinding,
  changeEmailBinding,
  verifyEmailChangeBinding,
  changePasswordBinding,
  changePhoneBinding,
  verifyPhoneChangeBinding,
  getPreferencesBinding,
  updatePreferencesBinding,
  listUsersBinding,
  createUserBinding,
  getUserBinding,
  updateUserBinding,
  deleteUserBinding,
  listUserSessionsBinding,
  resetUserTwoFactorBinding,
  revokeUserSessionsBinding,
];
