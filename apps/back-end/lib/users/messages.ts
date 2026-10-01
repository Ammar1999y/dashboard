import { MSG_CUSTOM_ROLE_NEEDS_PERMISSIONS } from '@app/shared/api-messages';
import { SESSIONS_MAX_PAGE_SIZE } from '@app/shared/validation/sessions';

export const userMsg = {
  passwordUpdateFailed:
    'تعذر تحديث كلمة المرور، هذا المستخدم لا يملك حساباً بكلمة مرور',
  cannotDeleteSelf: 'لا يمكنك حذف حسابك الخاص',
  roleNotFound: 'الدور غير موجود أو غير متاح',
  customRoleNeedsPermissions: MSG_CUSTOM_ROLE_NEEDS_PERMISSIONS,
  currentPasswordIncorrect: 'كلمة المرور الحالية غير صحيحة',
  accountTemporarilyLocked:
    'تم قفل الحساب مؤقتاً بسبب محاولات تسجيل دخول فاشلة متكررة. حاول مرة أخرى لاحقاً',
  passwordChanged: 'تم تغيير كلمة المرور بنجاح',
  emailChanged: 'تم تغيير البريد الإلكتروني بنجاح',
  newEmailSameAsCurrent: 'البريد الإلكتروني الجديد مطابق للحالي',
  newPasswordSameAsCurrent: 'كلمة المرور الجديدة مطابقة للحالية',
  ssoCannotModifyPassword:
    'لا يمكن تعديل كلمة المرور لحساب مرتبط بتسجيل دخول خارجي',
  emailChangeCodeSent:
    'تم إرسال رمز التحقق إلى البريد الإلكتروني الجديد. أدخل الرمز لتأكيد التغيير',
  phoneChanged: 'تم تغيير رقم الهاتف بنجاح',
  phoneChangeCodeSent:
    'تم إرسال رمز التحقق إلى رقم الهاتف الجديد. أدخل الرمز لتأكيد التغيير',
  newPhoneSameAsCurrent: 'رقم الهاتف الجديد مطابق للحالي',
  verificationUnavailable: 'خدمة التحقق غير متاحة حالياً. يرجى المحاولة لاحقاً',
  invalidSessionsCursor: 'مؤشر الصفحة غير صالح، اعد تحميل القائمة',
  invalidSessionsLimit: `حجم الصفحة يجب أن يكون رقماً بين 1 و ${SESSIONS_MAX_PAGE_SIZE}`,
};
