import type { DetectResult } from './detect-result';

import {
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@app/shared/api-messages';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
  FOLDER_RECURSIVE_DELETE_MAX,
} from '@app/shared/validation/constants';

export const mediaMsg = {
  fetched: MSG_FETCHED,
  uploaded: 'تم رفع الملف بنجاح',
  folderCreated: 'تم إنشاء المجلد بنجاح',
  updated: MSG_UPDATED,
  deleted: MSG_DELETED,
  published: 'تم نشر الملف',
  unpublished: 'تم إلغاء نشر الملف',

  folderNotFound: 'المجلد غير موجود',
  fileNotFound: 'الملف غير موجود',
  folderNameExists: 'يوجد مجلد بهذا الاسم في نفس المكان',
  folderNotEmpty: 'لا يمكن حذف مجلد يحتوي على ملفات أو مجلدات فرعية',
  folderTooLarge: `لا يمكن حذف مجلد يحتوي على أكثر من ${FOLDER_RECURSIVE_DELETE_MAX} عنصراً، احذف بعض المحتويات أولاً`,
  folderBusy:
    'يوجد ملفات قيد الرفع أو المعالجة داخل المجلد، حاول مرة أخرى بعد قليل',
  invalidRecursive: 'قيمة الحذف المتكرر غير صحيحة',
  folderTooDeep: `لا يمكن أن يتجاوز عمق المجلدات ${FOLDER_MAX_DEPTH} مستويات`,
  folderTooManyChildren: `لا يمكن أن يحتوي المجلد على أكثر من ${FOLDER_MAX_CHILDREN} مجلداً فرعياً`,
  folderCycle: 'لا يمكن نقل مجلد إلى داخل نفسه أو أحد مجلداته الفرعية',
  invalidScope: 'نطاق البحث غير صحيح',

  fileInUse: 'لا يمكن حذف ملف مرتبط بسجلات أخرى',
  fileInUseBy: (labels: readonly string[], hidden: number) =>
    `لا يمكن حذف الملف لأنه مستخدم في: ${labels.join('، ')}${
      hidden > 0 ? ` و${hidden} سجل آخر` : ''
    }`,
  fileBusy: 'الملف قيد المعالجة، حاول مرة أخرى بعد قليل',
  visibilityDisabled: 'هذا النوع من التخزين غير مفعل في هذا النظام',
  unpublishInUse: 'لا يمكن إلغاء نشر ملف مستخدم في محتوى منشور',
  linkVisibilityMismatch:
    'لا يمكن ربط الملف بهذا الغرض لأن مستوى خصوصيته مختلف، حاول مرة أخرى',
  linkNotAllowed: 'لا يمكن ربط هذا الملف بهذا السجل',

  invalidPurpose: 'الغرض من الرفع غير معروف',
  kindNotAllowedHere: 'هذا النوع من الملفات غير مسموح به هنا',
  typeNotAllowed: (name: string) => `نوع الملف "${name}" غير مدعوم`,
  documentTooLarge: (name: string, maxMb: number) =>
    `الملف "${name}" يتجاوز الحجم المسموح (${maxMb} ميجابايت)`,
  refused: (
    name: string,
    reason: Exclude<DetectResult, { ok: true }>['reason']
  ) =>
    ({
      signature: `محتوى الملف "${name}" لا يطابق نوعه المعلن`,
      container: `الملف "${name}" ليس ملفاً صالحاً من النوع المعلن`,
      mismatch: `الملف "${name}" من نوع مختلف عن النوع المعلن`,
      macros: `الملف "${name}" يحتوي على وحدات ماكرو وغير مسموح به`,
      embedded: `الملف "${name}" يحتوي على عناصر مضمنة وغير مسموح به`,
      encrypted: `الملف "${name}" محمي بكلمة مرور ولا يمكن التحقق منه`,
    })[reason],

  uploadFailed: 'حدث خطأ أثناء رفع الملف',
  storeFailed: 'حدث خطأ في التخزين، حاول مرة أخرى بعد قليل',
  fetchError: MSG_FETCH_ERROR,
  updateError: MSG_UPDATE_ERROR,
  deleteError: MSG_DELETE_ERROR,
};

/** The multipart form and the image pipeline. */
export const uploadMsg = {
  noFiles: 'لم يتم إرسال ملفات',
  noValidFiles: 'لم يتم إرسال ملفات صالحة',
  maxFiles: (max: number) => `الحد الأقصى ${max} ملفات في الطلب الواحد`,
  unexpectedFormField: (name: string) => `حقل غير متوقع في الطلب: ${name}`,
  fileTooLarge: (name: string, maxMB: number) =>
    `حجم الملف ${name} كبير جداً. الحد الأقصى: ${maxMB}MB`,
  contentMismatch: (name: string) =>
    `محتوى الملف ${name} لا يتطابق مع نوعه المعلن`,
  animatedNotAllowed: (name: string) =>
    `الملف ${name} صورة متحركة، والصور المتحركة غير مدعومة`,
  uploadFailed: 'حدث خطأ في رفع الملفات',
  invalidMimeType: (type: string) =>
    `نوع الملف غير مسموح: ${type}. الأنواع المسموحة: PNG, WebP, SVG`,
  invalidSvg: 'ملف SVG غير صالح',
  svgOptimizeFailed:
    'حدثت مشكله اثناء ضغط الايقونه، اعد المحاولة او قم برفع الايقونه مره اخرى',
  invalidInlineRaster:
    'الصورة المضمّنة داخل ملف SVG غير صالحة. الأنواع المسموحة داخل SVG: PNG, WebP',
  tooManyPixels: (maxMegapixels: number) =>
    `أبعاد الصورة كبيرة جداً. الحد الأقصى ${maxMegapixels} ميجابكسل`,
  edgeTooLong: (maxEdge: number) =>
    `أحد أبعاد الصورة كبير جداً. الحد الأقصى لكل بُعد ${maxEdge} بكسل`,
  undecodable: 'تعذّرت قراءة الصورة. الملف تالف أو غير مكتمل',
  targetUnreachable: 'تعذّر ضغط الصورة إلى الحجم المطلوب',
  iccProfileTooLarge: (maxKib: number) =>
    `ملف تعريف الألوان (ICC) المرفق بالصورة كبير جداً. الحد الأقصى ${maxKib}KB`,
  processingBusy: 'خدمة معالجة الصور مشغولة حالياً. حاول لاحقاً',
  invalidResource: 'المورد المطلوب رفع الصورة له غير صالح',
};
