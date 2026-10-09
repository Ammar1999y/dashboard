import type { SvgRejectionReason } from '../images/config';
import type { MediaRefusalReason } from '../validation/media-types';

import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
  FOLDER_RECURSIVE_DELETE_MAX,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
} from '../validation/constants';
import {
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from './common';
import {
  countOf,
  FILES_NOMINATIVE,
  ITEMS,
  LEVELS,
  OTHER_RECORDS,
  SUBFOLDERS,
} from './count';

// What the server answers an upload with, and what the front-end and its mock
// show for the same refusal, so it reads the same wherever it is caught.

export const MSG_FILE_UPLOADED = 'تم رفع الملف بنجاح';
export const MSG_UPLOAD_FAILED = 'حدث خطأ أثناء رفع الملف';
export const MSG_NO_FILES = 'لم يتم إرسال ملفات';
export const MSG_NO_VALID_FILES = 'لم يتم إرسال ملفات صالحة';
export const MSG_MAX_FILES = (max: number) =>
  `الحد الأقصى ${countOf(max, FILES_NOMINATIVE)} في الطلب الواحد`;
export const MSG_UNEXPECTED_FORM_FIELD = (name: string) =>
  `حقل غير متوقع في الطلب: ${name}`;
export const MSG_INVALID_UPLOAD_RESOURCE =
  'المورد المطلوب رفع الصورة له غير صالح';
export const MSG_INVALID_UPLOAD_PURPOSE = 'الغرض من الرفع غير معروف';

export const MSG_FILE_TOO_LARGE = (name: string, maxMB: number) =>
  `حجم الملف ${name} كبير جداً. الحد الأقصى: ${maxMB}MB`;
export const MSG_DOCUMENT_TOO_LARGE = (name: string, maxMb: number) =>
  `الملف "${name}" يتجاوز الحجم المسموح (${maxMb} ميجابايت)`;
export const MSG_FILE_TYPE_NOT_ALLOWED = (name: string) =>
  `نوع الملف "${name}" غير مدعوم`;
export const MSG_KIND_NOT_ALLOWED_HERE =
  'هذا النوع من الملفات غير مسموح به هنا';

export const MSG_ANIMATION_UNSUPPORTED = 'الصور المتحركة غير مدعومة';
export const MSG_ANIMATED_NOT_ALLOWED = (name: string) =>
  `الملف ${name} صورة متحركة، والصور المتحركة غير مدعومة`;
export const MSG_IMAGE_TOO_MANY_PIXELS = (maxMegapixels: number) =>
  `أبعاد الصورة كبيرة جداً. الحد الأقصى ${maxMegapixels} ميجابكسل`;
export const MSG_IMAGE_EDGE_TOO_LONG = (maxEdge: number) =>
  `أحد أبعاد الصورة كبير جداً. الحد الأقصى لكل بُعد ${maxEdge} بكسل`;
export const MSG_IMAGE_TARGET_UNREACHABLE =
  'تعذّر ضغط الصورة إلى الحجم المطلوب';

export const MSG_INVALID_SVG = 'ملف SVG غير صالح';
export const MSG_SVG_INVALID_INLINE_RASTER =
  'الصورة المضمّنة داخل ملف SVG غير صالحة. الأنواع المسموحة داخل SVG: PNG, WebP';
export const MSG_SVG_OPTIMIZE_FAILED =
  'حدثت مشكلة أثناء ضغط الأيقونة، أعد المحاولة أو قم برفع الأيقونة مرة أخرى';
export const MSG_SVG_REQUIRES_CONVERSION =
  'ملف SVG هذا يحتاج إلى تحويل. صدّره بصيغة PNG أو WebP ثم ارفعه مرة أخرى';
export const MSG_SVG_EXTERNAL_REFERENCE =
  'ملف SVG هذا يرتبط بملفات خارجية. ضمّنها داخل الملف أو صدّره بصيغة PNG أو WebP';

/** Without a file name, as `sanitizeSvg` reports them. */
export const SVG_REFUSALS: Readonly<Record<SvgRejectionReason, string>> = {
  animated: MSG_ANIMATION_UNSUPPORTED,
  'edge-too-long': MSG_IMAGE_EDGE_TOO_LONG(MAX_IMAGE_EDGE),
  'external-reference': MSG_SVG_EXTERNAL_REFERENCE,
  'invalid-inline-raster': MSG_SVG_INVALID_INLINE_RASTER,
  'requires-conversion': MSG_SVG_REQUIRES_CONVERSION,
  'too-many-pixels': MSG_IMAGE_TOO_MANY_PIXELS(
    Math.floor(MAX_IMAGE_PIXELS / 1_000_000)
  ),
};

export const mediaMsg = {
  fetched: MSG_FETCHED,
  uploaded: MSG_FILE_UPLOADED,
  folderCreated: 'تم إنشاء المجلد بنجاح',
  updated: MSG_UPDATED,
  deleted: MSG_DELETED,
  published: 'تم نشر الملف',
  unpublished: 'تم إلغاء نشر الملف',

  folderNotFound: 'المجلد غير موجود',
  fileNotFound: 'الملف غير موجود',
  folderNameExists: 'يوجد مجلد بهذا الاسم في نفس المكان',
  folderNotEmpty: 'لا يمكن حذف مجلد يحتوي على ملفات أو مجلدات فرعية',
  folderTooLarge: `لا يمكن حذف مجلد يحتوي على أكثر من ${countOf(FOLDER_RECURSIVE_DELETE_MAX, ITEMS)}، احذف بعض المحتويات أولاً`,
  selectionTooLarge: `لا يمكن حذف أكثر من ${countOf(FOLDER_RECURSIVE_DELETE_MAX, ITEMS)} في المرة الواحدة، قلّل التحديد أو احذف بعض المحتويات أولاً`,
  folderBusy:
    'يوجد ملفات قيد الرفع أو المعالجة داخل المجلد، حاول مرة أخرى بعد قليل',
  invalidRecursive: 'قيمة الحذف المتكرر غير صحيحة',
  folderTooDeep: `لا يمكن أن يتجاوز عمق المجلدات ${countOf(FOLDER_MAX_DEPTH, LEVELS)}`,
  folderTooManyChildren: `لا يمكن أن يحتوي المجلد على أكثر من ${countOf(FOLDER_MAX_CHILDREN, SUBFOLDERS)}`,
  folderCycle: 'لا يمكن نقل مجلد إلى داخل نفسه أو أحد مجلداته الفرعية',
  invalidScope: 'نطاق البحث غير صحيح',

  fileInUse: 'لا يمكن حذف ملف مرتبط بسجلات أخرى',
  fileInUseBy: (labels: readonly string[], hidden: number) =>
    `لا يمكن حذف الملف لأنه مستخدم في: ${labels.join('، ')}${
      hidden > 0 ? ` و${countOf(hidden, OTHER_RECORDS)}` : ''
    }`,
  fileBusy: 'الملف قيد المعالجة، حاول مرة أخرى بعد قليل',
  visibilityDisabled: 'هذا النوع من التخزين غير مفعل في هذا النظام',
  unpublishInUse: 'لا يمكن إلغاء نشر ملف مستخدم في محتوى منشور',
  linkVisibilityMismatch:
    'لا يمكن ربط الملف بهذا الغرض لأن مستوى خصوصيته مختلف، حاول مرة أخرى',
  linkNotAllowed: 'لا يمكن ربط هذا الملف بهذا السجل',

  invalidPurpose: MSG_INVALID_UPLOAD_PURPOSE,
  kindNotAllowedHere: MSG_KIND_NOT_ALLOWED_HERE,
  typeNotAllowed: MSG_FILE_TYPE_NOT_ALLOWED,
  documentTooLarge: MSG_DOCUMENT_TOO_LARGE,
  refused: (name: string, reason: MediaRefusalReason) =>
    ({
      signature: `محتوى الملف "${name}" لا يطابق نوعه المعلن`,
      container: `الملف "${name}" ليس ملفاً صالحاً من النوع المعلن`,
      mismatch: `الملف "${name}" من نوع مختلف عن النوع المعلن`,
      macros: `الملف "${name}" يحتوي على وحدات ماكرو وغير مسموح به`,
      embedded: `الملف "${name}" يحتوي على عناصر مضمنة وغير مسموح به`,
      encrypted: `الملف "${name}" محمي بكلمة مرور ولا يمكن التحقق منه`,
    })[reason],

  uploadFailed: MSG_UPLOAD_FAILED,
  storeFailed: 'حدث خطأ في التخزين، حاول مرة أخرى بعد قليل',
  fetchError: MSG_FETCH_ERROR,
  updateError: MSG_UPDATE_ERROR,
  deleteError: MSG_DELETE_ERROR,
};

/** The multipart form and the image pipeline. */
export const uploadMsg = {
  noFiles: MSG_NO_FILES,
  noValidFiles: MSG_NO_VALID_FILES,
  maxFiles: MSG_MAX_FILES,
  unexpectedFormField: MSG_UNEXPECTED_FORM_FIELD,
  fileTooLarge: MSG_FILE_TOO_LARGE,
  contentMismatch: (name: string) =>
    `محتوى الملف ${name} لا يتطابق مع نوعه المعلن`,
  animatedNotAllowed: MSG_ANIMATED_NOT_ALLOWED,
  uploadFailed: 'حدث خطأ في رفع الملفات',
  invalidMimeType: (type: string) =>
    `نوع الملف غير مسموح: ${type}. الأنواع المسموحة: PNG, WebP, SVG`,
  svgOptimizeFailed: MSG_SVG_OPTIMIZE_FAILED,
  tooManyPixels: MSG_IMAGE_TOO_MANY_PIXELS,
  edgeTooLong: MSG_IMAGE_EDGE_TOO_LONG,
  undecodable: 'تعذّرت قراءة الصورة. الملف تالف أو غير مكتمل',
  targetUnreachable: MSG_IMAGE_TARGET_UNREACHABLE,
  iccProfileTooLarge: (maxKib: number) =>
    `ملف تعريف الألوان (ICC) المرفق بالصورة كبير جداً. الحد الأقصى ${maxKib}KB`,
  processingBusy: 'خدمة معالجة الصور مشغولة حالياً. حاول لاحقاً',
  invalidResource: MSG_INVALID_UPLOAD_RESOURCE,
};
