import type { PasswordRule } from '@app/shared/validation/rules';

import {
  CHARACTERS,
  countOf,
  FILES,
  ITEMS_NOMINATIVE,
} from '@app/shared/messages/count';
import { MSG_FILE_TYPE_NOT_ALLOWED } from '@app/shared/messages/media';
import { PASSWORD_MAX, PASSWORD_MIN } from '@app/shared/validation/constants';

// Messages the client writes itself. A message the server also sends comes from
// `@app/shared/messages/*` instead.

export const MSG_OFFLINE = 'لا يوجد اتصال بالإنترنت، أعد المحاولة';
export const MSG_UNEXPECTED_ERROR = 'حدث خطأ غير متوقع';
export const MSG_GENERIC_ERROR = 'حدث خطأ، أعد المحاولة';
export const MSG_ENCODE_FAILED = 'تعذر تجهيز البيانات للإرسال';
export const MSG_SAVED_NOT_SHOWN =
  'تم الحفظ، لكن تعذر تحديث العرض. أعد تحميل الصفحة';
export const MSG_NO_RESULTS = 'لا توجد نتائج';
export const MSG_INVALID_LINK = 'رابط السجل غير صالح';
export const MSG_LOADING = 'جاري التحميل...';
export const MSG_RETRY = 'أعد المحاولة';
export const MSG_PAGE_NOT_FOUND_DETAIL =
  'الرابط غير صحيح، أو أن الصفحة نُقلت أو حُذفت.';
export const MSG_PAGE_FAILED_DETAIL =
  'تعذر عرض هذه الصفحة. أعد المحاولة بعد قليل.';
export const MSG_BROWSER_UNSUPPORTED =
  'المتصفح غير مدعوم، قم بتغيير المتصفح أو استخدام آخر نسخة للمتابعة.';
export const MSG_TWO_FACTOR_SIGN_IN_UNSUPPORTED =
  'هذا الحساب مفعّل عليه التحقق بخطوتين، وتسجيل الدخول به غير مدعوم هنا بعد';
export const MSG_POPUP_BLOCKED =
  'منع المتصفح فتح نافذة جديدة، اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة';
export const MSG_FONT_LOAD_FAILED =
  'تعذر تحميل الخط، تحقق من الاتصال أو اختر خطاً آخر';

export const MSG_PROCESSING_FAILED = 'فشلت معالجة الملف';
/** For a refusal that does not name the file: one pick can hold several. */
export const MSG_FOR_FILE = (name: string, message: string) =>
  `${name}: ${message}`;
export const MSG_IMAGE_UNSUPPORTED = (name: string) =>
  `تعذّرت معالجة الصورة "${name}"، قد تكون صيغتها غير مدعومة. حوّلها إلى PNG أو JPG أو WebP`;
export const MSG_SVG_CONVERTED = (name: string) =>
  `حُوِّل ملف SVG "${name}" إلى صورة لأنه يستخدم تنسيقات لا تُحفظ كـ SVG`;
export const MSG_SVG_CONVERSION_FAILED = (name: string) =>
  `تعذّر تحويل ملف SVG "${name}" إلى صورة. صدّره بصيغة PNG أو WebP وحاول مرة أخرى`;

export const joinFormats = (formats: readonly string[]) => formats.join('، ');

export const MSG_SUPPORTED_FORMATS = (formats: readonly string[]) =>
  `الصيغ المدعومة: ${joinFormats(formats)}`;

export const MSG_FILE_INVALID_TYPE = (
  name: string,
  formats: readonly string[]
) =>
  formats.length > 0
    ? `نوع الملف "${name}" غير مدعوم، الصيغ المدعومة: ${joinFormats(formats)}`
    : MSG_FILE_TYPE_NOT_ALLOWED(name);

export const MSG_FILE_REJECTED = (name: string) => `تعذّر قبول الملف "${name}"`;

// Not `MSG_MAX_FILES`: that one is the server's per-request ceiling, and this
// one is the dropzone's.
export const MSG_TOO_MANY_FILES = (maxFiles: number) =>
  `يمكنك رفع ${countOf(maxFiles, FILES)} فقط`;

export const MSG_PASSWORD_MUST_CONTAIN = 'يجب أن تحتوي على:';
export const MSG_PASSWORD_REQUIREMENTS = {
  length: `يجب أن تكون بين ${PASSWORD_MIN} و${countOf(PASSWORD_MAX, CHARACTERS)}`,
  digit: 'يجب أن تحتوي على رقم واحد على الأقل',
  lowercase: 'يجب أن تحتوي على حرف صغير واحد على الأقل',
  uppercase: 'يجب أن تحتوي على حرف كبير واحد على الأقل',
  other: 'يجب أن تحتوي على رمز خاص واحد على الأقل',
  singleLine: 'يجب ألا تحتوي على فاصل أسطر',
} as const satisfies Record<PasswordRule, string>;

export const MSG_TITLE_REQUIRED = 'العنوان مطلوب';
export const MSG_TITLE_TOO_LONG = (max: number) =>
  `العنوان يجب أن لا يتجاوز ${countOf(max, CHARACTERS)}`;
export const MSG_LINK_REQUIRED = 'الرابط مطلوب';
export const MSG_LINK_TOO_LONG = (max: number) =>
  `الرابط يجب أن لا يتجاوز ${countOf(max, CHARACTERS)}`;
export const MSG_KEY_REQUIRED = 'المفتاح مطلوب';

export const MSG_ROWS_DUPLICATE_ID = 'العناصر يجب أن لا تتكرر';
export const MSG_ROWS_DUPLICATE_KEY = 'المفتاح يجب أن لا يتكرر';
export const MSG_LIST_TOO_LONG = (max: number) =>
  `تجاوزت أكبر عدد للعناصر، وهو ${countOf(max, ITEMS_NOMINATIVE)}`;

export const MSG_SITE_TITLE_TOO_LONG = (max: number) =>
  `عنوان الموقع يجب أن لا يتجاوز ${countOf(max, CHARACTERS)}`;
export const MSG_SITE_DESCRIPTION_TOO_LONG = (max: number) =>
  `وصف الموقع يجب أن لا يتجاوز ${countOf(max, CHARACTERS)}`;
export const MSG_FOOTER_DESCRIPTION_TOO_LONG = (max: number) =>
  `وصف الفوتر يجب أن لا يتجاوز ${countOf(max, CHARACTERS)}`;
export const MSG_COPYRIGHT_TOO_LONG = (max: number) =>
  `نص الحقوق يجب أن لا يتجاوز ${countOf(max, CHARACTERS)}`;
export const MSG_FONT_NAME_TOO_LONG = 'اسم الخط طويل جداً';

export const MSG_LETTER_SPACING_INVALID = 'تباعد الأحرف يجب أن يكون رقماً';
export const MSG_LETTER_SPACING_MIN = (min: number) =>
  `تباعد الأحرف يجب أن يكون أكبر من ${min}`;
export const MSG_LETTER_SPACING_MAX = (max: number) =>
  `تباعد الأحرف يجب أن يكون أقل من ${max}`;
export const MSG_LINE_HEIGHT_INVALID = 'تباعد الأسطر يجب أن يكون رقماً';
export const MSG_LINE_HEIGHT_MIN = (min: number) =>
  `تباعد الأسطر يجب أن يكون أكبر من ${min}`;
export const MSG_LINE_HEIGHT_MAX = (max: number) =>
  `تباعد الأسطر يجب أن يكون أقل من ${max}`;
export const MSG_FONT_SIZE_MULTIPLIER_INVALID =
  'مضاعف حجم الخط يجب أن يكون رقماً';
export const MSG_FONT_SIZE_MULTIPLIER_MIN = (min: number) =>
  `مضاعف حجم الخط يجب أن يكون أكبر من ${min}`;
export const MSG_FONT_SIZE_MULTIPLIER_MAX = (max: number) =>
  `مضاعف حجم الخط يجب أن يكون أقل من ${max}`;

export const MSG_SOCIAL_ACCOUNTS_INVALID = 'قم بإدخال حسابات التواصل بشكل صحيح';
export const MSG_CONTACT_INFO_INVALID = 'قم بإدخال بيانات التواصل بشكل صحيح';
export const MSG_NAV_LINKS_INVALID = 'قم بإدخال الروابط بشكل صحيح';
