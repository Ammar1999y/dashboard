import type { DashboardPage, PermissionAction } from '../permissions/constants';

/**
 * Total `Record`s: a page or action added to `permissions/constants` without a
 * label here, or a label for one that does not exist, is a compile error rather
 * than a lookup that returns `undefined` at runtime. Type-only import, so
 * `permissions/constants` and this file never form a runtime cycle.
 */
export const DASHBOARD_PAGE_LABELS: Record<DashboardPage, string> = {
  home: 'الرئيسية',
  users: 'المستخدمين',
  permissions: 'الصلاحيات',
  media: 'الملفات',
};

export const PERMISSION_ACTION_LABELS: Record<PermissionAction, string> = {
  view: 'عرض الكل',
  viewOwn: 'عرض الخاص',
  edit: 'تعديل الكل',
  editOwn: 'تعديل الخاص',
  delete: 'حذف الكل',
  deleteOwn: 'حذف الخاص',
  create: 'إنشاء',
  resetTwoFactor: 'إعادة تعيين التحقق بخطوتين',
  publish: 'نشر',
};

export const MSG_INSUFFICIENT_PERMISSIONS = 'ليس لديك صلاحية';
export const MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS =
  'لا يمكنك منح صلاحيات لا تملكها';
export const MSG_ROLE_NAME_EXISTS = 'اسم الصلاحية موجود بالفعل، قم بتغييره';
export const MSG_ROLE_HAS_USERS =
  'لا يمكن حذف هذه الصلاحية لأنها مرتبطة بمستخدمين';
export const MSG_CANNOT_EDIT_OWN_ROLE = 'لا يمكنك تعديل الدور المخصص لحسابك';
export const MSG_CUSTOM_ROLE_PREFIX_FORBIDDEN = (prefix: string) =>
  `لا يمكن أن يبدأ اسم الدور بـ "${prefix}"`;

export const permissionMsg = {
  nameExists: MSG_ROLE_NAME_EXISTS,
  duplicatePagePermission: 'صلاحية الصفحة مكررة',
  hasUsers: MSG_ROLE_HAS_USERS,
  cannotEditOwnRole: MSG_CANNOT_EDIT_OWN_ROLE,
};
