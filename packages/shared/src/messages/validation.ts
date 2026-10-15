import {
  EMAIL_MAX,
  FOLDER_NAME_MAX,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  IDS_ARRAY_MAX,
  MEDIA_DISPLAY_NAME_MAX,
  NAME_MAX,
  OTP_CODE_LENGTH,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PERMISSIONS_ARRAY_MAX,
  PRESET_NAME_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
} from '../validation/constants';
import {
  CHARACTERS,
  countOf,
  DIGITS,
  FILES,
  ITEMS,
  PERMISSIONS,
  SESSIONS_NOMINATIVE,
} from './count';

// What a request schema answers a malformed body with. Imports constants only:
// the schemas import this file, so it must never import one back.

/** `zodIssueMessage` replaces any message without Arabic script, so every one stays Arabic. */
export const idRequired =
  'رقم المعرف غير صحيح، أعد تحميل الصفحة ثم حاول مرة أخرى';

/**
 * A server-owned Arabic message per issue code, for every schema node that did
 * not author one.
 *
 * An issue code absent from this map takes `MSG_INVALID_INPUT` (`common.ts`) in
 * `localizedIssueMessage`, so `invalid_union` needs no entry — that is the
 * message it would carry.
 *
 * Mapped here rather than at each node, because a node is exactly where it gets
 * forgotten, and a Zod default is an English message in an Arabic dashboard.
 */
export const ISSUE_FALLBACKS: Readonly<Record<string, string>> = {
  invalid_type: 'قيمة الحقل مفقودة أو من نوع غير صحيح',
  invalid_value: 'قيمة الحقل غير مسموحة',
  invalid_format: 'تنسيق قيمة الحقل غير صحيح',
  invalid_key: 'أحد مفاتيح الطلب غير صالح',
  invalid_element: 'أحد عناصر القائمة غير صالح',
  too_big: 'القيمة أكبر من الحد المسموح',
  too_small: 'القيمة أصغر من الحد المسموح',
  not_multiple_of: 'القيمة غير صحيحة',
  // Only where the keys themselves did not arrive: `MSG_UNRECOGNIZED_KEYS` names them.
  unrecognized_keys: 'حقول غير معروفة في الطلب',
};

/** `hidden` counts the offending keys left out of `keys`, which the caller bounds. */
export const MSG_UNRECOGNIZED_KEYS = (
  keys: readonly string[],
  hidden: number
) =>
  `حقول غير معروفة في الطلب: ${keys.join('، ')}${hidden > 0 ? ` (+${hidden})` : ''}`;

export const MSG_EMAIL_INVALID = 'يرجى إدخال بريد إلكتروني صحيح';
export const MSG_EMAIL_TOO_LONG = `يجب أن لا يتجاوز البريد الإلكتروني ${countOf(EMAIL_MAX, CHARACTERS)}`;
export const MSG_EMAIL_PROVIDER_NOT_ACCEPTED =
  'نعتذر، حالياً نقبل التسجيل فقط عبر بريد Gmail أو Outlook أو Hotmail أو Yahoo. يرجى استخدام أحد هذه العناوين.';

export const MSG_PASSWORD_REQUIRED = 'كلمة المرور مطلوبة';
export const MSG_PASSWORD_TOO_SHORT = `كلمة المرور يجب أن تكون ${countOf(PASSWORD_MIN, CHARACTERS)} على الأقل`;
export const MSG_PASSWORD_TOO_LONG = `كلمة المرور يجب أن لا تتجاوز ${countOf(PASSWORD_MAX, CHARACTERS)}`;
export const MSG_PASSWORD_INVALID = 'تحقق من صحة كلمة المرور';

export const MSG_PHONE_REQUIRED = 'رقم الهاتف مطلوب';
export const MSG_PHONE_INVALID = 'يرجى إدخال رقم هاتف سعودي صحيح';
export const MSG_PHONE_DISABLED = 'رقم الهاتف غير مُفعّل في النظام';

export const MSG_COLOR_INVALID = 'قم بإدخال لون صحيح';

export const MSG_SLUG_TOO_LONG = 'الـ slug طويل جداً';
export const MSG_SLUG_INVALID_CHARACTERS = 'الـ slug يحتوي على أحرف غير مسموحة';
export const MSG_SLUG_DIGITS_ONLY = 'الـ slug لا يمكن أن يكون أرقاماً فقط';

export const MSG_CAPTCHA_REQUIRED = 'الرجاء التحقق من أنك لست روبوتاً';

export const MSG_NAME_REQUIRED = 'الاسم مطلوب';
export const MSG_NAME_TOO_LONG = `الاسم يجب أن لا يتجاوز ${countOf(NAME_MAX, CHARACTERS)}`;

export const MSG_PERMISSIONS_ONLY_FOR_CUSTOM_ROLE =
  'الصلاحيات مسموح بها فقط عند اختيار دور مخصص';

export const MSG_OTP_REQUIRED = 'رمز التحقق مطلوب';
export const MSG_OTP_WRONG_LENGTH = `رمز التحقق يجب أن يكون ${countOf(OTP_CODE_LENGTH, DIGITS)}`;
export const MSG_OTP_DIGITS_ONLY = 'رمز التحقق يجب أن يحتوي على أرقام فقط';
export const MSG_RECOVERY_CODE_INVALID = 'رمز الاسترجاع غير صحيح';

export const MSG_TWO_FACTOR_CONTACT_REQUIRED =
  'يجب تحديد وسيلة الإرسال (البريد أو الهاتف)';

export const MSG_SESSION_IDS_REQUIRED = 'يجب تحديد جلسة واحدة على الأقل';
export const MSG_SESSION_IDS_TOO_MANY = `الحد الأقصى ${countOf(IDS_ARRAY_MAX, SESSIONS_NOMINATIVE)} في الطلب`;
// Zod answers with this when no branch of the union got far enough to report its
// own issue, so it names both shapes the body may take.
export const MSG_SESSIONS_DELETE_SHAPE =
  'حدد جلسة واحدة على الأقل عبر sessionIds، أو أرسل revokeAll: true لإنهاء الجلسات الأخرى';

export const mediaValidationMsg = {
  folderNameRequired: 'اسم المجلد مطلوب',
  folderNameTooLong: `اسم المجلد يجب أن لا يتجاوز ${countOf(FOLDER_NAME_MAX, CHARACTERS)}`,
  folderNameInvalid: 'اسم المجلد يحتوي على أحرف غير مسموحة',
  displayNameRequired: 'اسم الملف مطلوب',
  displayNameTooLong: `اسم الملف يجب أن لا يتجاوز ${countOf(MEDIA_DISPLAY_NAME_MAX, CHARACTERS)}`,
  displayNameInvalid: 'اسم الملف يحتوي على أحرف غير مسموحة',
  idsRequired: 'يجب تحديد ملف واحد على الأقل',
  idsTooMany: `يمكن تحديد ${countOf(IDS_ARRAY_MAX, FILES)} كحد أقصى في الطلب الواحد`,
  selectionRequired: 'يجب تحديد عنصر واحد على الأقل',
  selectionTooMany: `يمكن تحديد ${countOf(IDS_ARRAY_MAX, ITEMS)} كحد أقصى في الطلب الواحد`,
  filesToRoot: 'لا يمكن نقل الملفات إلى الجذر، اختر مجلدًا',
  nothingToUpdate: 'لا يوجد ما يتم تحديثه',
};

export const preferencesValidationMsg = {
  presetTooLong: `اسم السمة يجب أن لا يتجاوز ${countOf(PRESET_NAME_MAX, CHARACTERS)}`,
  presetInvalid: 'اسم السمة يحتوي على أحرف غير مسموحة',
  fontScaleOutOfRange: `حجم الخط يجب أن يكون بين ${FONT_SCALE_MIN} و ${FONT_SCALE_MAX}`,
};

export const permissionValidationMsg = {
  roleNameMaxLength: `اسم الدور يجب أن لا يتجاوز ${countOf(ROLE_NAME_MAX, CHARACTERS)}`,
  descriptionMaxLength: `الوصف يجب أن لا يتجاوز ${countOf(ROLE_DESCRIPTION_MAX, CHARACTERS)}`,
  roleNameRequired: 'اسم الدور مطلوب',
  permissionsMaxLength: `عدد الصلاحيات يجب أن لا يتجاوز ${countOf(PERMISSIONS_ARRAY_MAX, PERMISSIONS)}`,
  permissionsRequired: 'الصلاحيات مطلوبة',
  duplicatePageNames: 'أسماء الصفحات يجب أن لا تتكرر',
  viewRequiredForWrite:
    'يجب تفعيل صلاحية العرض عند تفعيل أي صلاحية كتابة (إنشاء، تعديل، حذف)',
  actionUnavailableForPage: (action: string, page: string) =>
    `الصلاحية "${action}" غير متاحة لصفحة "${page}"`,
};
