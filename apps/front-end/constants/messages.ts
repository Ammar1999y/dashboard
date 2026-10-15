import type { CountForms } from '@app/shared/messages/count';
import type { DashboardPage } from '@app/shared/permissions/constants';
import type { PasswordRule } from '@app/shared/validation/rules';

import {
  CHARACTERS,
  countOf,
  DAYS,
  FILES,
  FILES_NOMINATIVE,
  ITEMS,
  ITEMS_NOMINATIVE,
  OTHER_RECORDS,
  SECONDS,
  SESSIONS,
} from '@app/shared/messages/count';
import { MSG_FILE_TYPE_NOT_ALLOWED } from '@app/shared/messages/media';
import {
  DASHBOARD_PAGE_LABELS,
  PERMISSION_ACTION_LABELS,
} from '@app/shared/messages/permissions';
import {
  IDS_ARRAY_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from '@app/shared/validation/constants';

// Messages the client writes itself. A message the server also sends comes from
// `@app/shared/messages/*` instead.

export const MSG_OFFLINE = 'لا يوجد اتصال بالإنترنت، أعد المحاولة';
export const MSG_UNEXPECTED_ERROR = 'حدث خطأ غير متوقع';
export const MSG_GENERIC_ERROR = 'حدث خطأ، أعد المحاولة';
export const MSG_ENCODE_FAILED = 'تعذر تجهيز البيانات للإرسال';
export const MSG_SAVED_NOT_SHOWN =
  'تم الحفظ، لكن تعذر تحديث العرض. أعد تحميل الصفحة';
export const MSG_NO_RESULTS = 'لا توجد نتائج';
export const MSG_FIND_FIELD = 'ابحث عن حقل...';
export const MSG_NO_FIELDS = 'لا توجد حقول.';
export const MSG_EDIT_FILTERS = 'عدّل التصفيات لتحسين النتائج.';
export const MSG_NO_FILTERS = 'لا توجد تصفيات، أضف تصفيات لتحسين النتائج.';
export const MSG_EDIT_SORT = 'عدّل الترتيب لتنظيم الصفوف.';
export const MSG_NO_SORT = 'لا يوجد ترتيب، أضف ترتيبًا لتنظيم الصفوف.';
export const MSG_INVALID_LINK = 'رابط السجل غير صالح';
export const MSG_LOADING = 'جاري التحميل...';
export const MSG_RETRY = 'أعد المحاولة';
export const MSG_UNDO = 'تراجع';
export const MSG_PAGE_NOT_FOUND_DETAIL =
  'الرابط غير صحيح، أو أن الصفحة نُقلت أو حُذفت.';
export const MSG_PAGE_FAILED_DETAIL =
  'تعذر عرض هذه الصفحة. أعد المحاولة بعد قليل.';
export const MSG_BROWSER_UNSUPPORTED =
  'المتصفح غير مدعوم، قم بتغيير المتصفح أو استخدام آخر نسخة للمتابعة.';
export const MSG_TWO_FACTOR_CHOOSE = 'اختر طريقة التحقق';
export const MSG_TWO_FACTOR_TOTP = 'أدخل الرمز الظاهر الآن في تطبيق المصادقة';
export const MSG_TWO_FACTOR_BACKUP_CODE =
  'أدخل أحد رموزك الاحتياطية. يُستهلك الرمز بعد استعماله مرة واحدة';
export const MSG_TWO_FACTOR_OTP_EMAIL =
  'يُرسل رمز التحقق إلى البريد الإلكتروني المسجّل في حسابك';
export const MSG_TWO_FACTOR_OTP_PHONE =
  'يُرسل رمز التحقق إلى رقم الهاتف المسجّل في حسابك';
export const MSG_TWO_FACTOR_PASSKEY =
  'استخدم بصمتك أو وجهك أو رمز جهازك لإكمال التحقق';
export const MSG_TWO_FACTOR_TRUST_DEVICE =
  'الوثوق بهذا الجهاز وعدم طلب التحقق بخطوتين عليه لاحقاً';
export const MSG_TWO_FACTOR_RESTART_HINT =
  'انتهت الجلسة أو تجاوزت عدد المحاولات؟';
export const MSG_TWO_FACTOR_UNAVAILABLE_HELP =
  'يمكن للمسؤول إعادة تعيين التحقق بخطوتين لحسابك، وتحذف إعادة التعيين الرموز الاحتياطية ومفاتيح المرور المسجّلة. بعدها سجّل الدخول من جديد.';
export const MSG_TRUST_DEVICE_FAILED =
  'تم تسجيل الدخول، لكن تعذّر حفظ هذا الجهاز كجهاز موثوق';
export const MSG_RESEND_IN = (seconds: number) =>
  `إعادة الإرسال بعد ${countOf(seconds, SECONDS)}`;
export const MSG_OAUTH_EXPIRED =
  'انتهت مهلة تسجيل الدخول بحساب Google، أو بدأت من متصفح آخر. ابدأ من جديد.';
export const MSG_OAUTH_FAILED =
  'تعذّر تسجيل الدخول بحساب Google. أعد المحاولة أو استخدم طريقة أخرى.';
export const MSG_OAUTH_FINISHING = 'جاري إكمال تسجيل الدخول...';
export const MSG_PASSWORDLESS_INTRO =
  'أدخل وسيلة التواصل المسجّلة في حسابك ليصلك رمز يسجّل دخولك بلا كلمة مرور';
export const MSG_ENTER_CODE_SENT = 'أدخل الرمز الذي وصلك';
export const MSG_RESEND_CODE = 'لم يصلك الرمز؟ إرسال رمز جديد';
export const MSG_BACK_TO_SIGN_IN = 'العودة إلى تسجيل الدخول';
export const MSG_REMEMBER_ME = 'تذكّرني';
export const MSG_FORGOT_PASSWORD_INTRO =
  'أدخل وسيلة التواصل المسجّلة في حسابك ليصلك رمز إعادة تعيين كلمة المرور';
export const MSG_VERIFY_CONTACT_EMAIL_INTRO =
  'سنرسل رمزاً إلى بريدك الإلكتروني لتأكيده، ثم يمكنك تسجيل الدخول';
export const MSG_VERIFY_CONTACT_PHONE_INTRO =
  'أدخل رقم هاتفك المسجّل في الحساب ليصلك رمز يؤكّده، ثم يمكنك تسجيل الدخول';
export const MSG_PASSKEY_CANCELLED =
  'أُلغيت العملية أو انتهت مهلتها، أو لا يوجد مفتاح مرور مناسب على هذا الجهاز';
export const MSG_PASSKEY_ALREADY_REGISTERED =
  'مفتاح المرور لهذا الجهاز مسجّل بالفعل';
export const MSG_PASSKEY_FAILED =
  'تعذّر إكمال العملية على هذا الجهاز. أعد المحاولة أو استخدم جهازاً آخر';
export const MSG_REAUTH_DESCRIPTION =
  'هذا إجراء حساس. أكّد هويتك للمتابعة، ولن يُطلب منك ذلك مجدداً لفترة قصيرة.';
export const MSG_REAUTH_NO_METHODS = 'لا توجد طريقة تأكيد متاحة لحسابك';
export const MSG_REAUTH_PROVEN_RESUBMIT =
  'تم تأكيد هويتك، لكن رمز التحقق من أنك لست روبوتاً استُهلك. أرسل النموذج مرة أخرى لإتمام العملية.';
export const MSG_CONFIRM_DELETE = (noun: string, name: string) =>
  `سوف يتم حذف ${noun} «${name}». هذا الإجراء لا يمكن التراجع عنه.`;
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

export const MSG_LONG_OPERATION =
  'قد تستغرق هذه العملية دقيقتين. انتظر حتى تنتهي.';

// The media library. Its count tables are client-only: the server never
// counts folders or batches.

// Genitive: «يحتوي …», «داخل …».
const FOLDERS: CountForms = {
  one: 'مجلد واحد',
  two: 'مجلدين',
  few: '# مجلدات',
  many: '# مجلداً',
  other: '# مجلد',
};

// Nominative: «سيُنقل …».
const FOLDERS_NOMINATIVE: CountForms = { ...FOLDERS, two: 'مجلدان' };

// Genitive: «إلى …».
const BATCHES: CountForms = {
  one: 'دفعة واحدة',
  two: 'دفعتين',
  few: '# دفعات',
  many: '# دفعة',
  other: '# دفعة',
};

// Nominative, after «و» closing a list of names.
const OTHER_ITEMS: CountForms = {
  one: 'عنصر آخر',
  two: 'عنصران آخران',
  few: '# عناصر أخرى',
  many: '# عنصراً آخر',
  other: '# عنصر آخر',
};

export const MSG_LIBRARY_ROOT = 'المكتبة';
export const MSG_FOLDERS_TRUNCATED =
  'هناك مجلدات أخرى تطابق البحث، ضيّق نص البحث للوصول إليها.';
export const MSG_NO_SUBFOLDERS = 'لا توجد مجلدات فرعية هنا';
export const MSG_PATH_UNKNOWN = 'تعذّر تحميل المسار';
export const MSG_STORAGE_FAILED = 'تعذّر التحميل';
export const MSG_STORAGE_TOTALS = (folders: number, files: number) =>
  `المكتبة كلها: ${countOf(folders, FOLDERS)} و${countOf(files, FILES)}. انقر للتحديث.`;
export const MSG_UNFILED_NOTICE = (days: number) =>
  `ملفات لا مجلد لها ولا سجل يملكها. تُحذف نهائياً بعد ${countOf(days, DAYS)} من اكتشافها ما لم تُنقل إلى مجلد.`;
export const MSG_UNFILED_DELETION = (days: number) =>
  days > 0
    ? `تُحذف بعد ${countOf(days, DAYS)}`
    : 'تُحذف عند المسح الليلي القادم';

export const MSG_EMPTY_FOLDER =
  'اسحب ملفات من جهازك وأفلتها هنا، أو ابدأ بالرفع.';
export const MSG_EMPTY_ROOT =
  'تُحفظ الملفات داخل المجلدات فقط، فأنشئ أول مجلد لتبدأ.';
export const MSG_EMPTY_SEARCH = 'جرّب كلمة أخرى أو أزل بعض عوامل التصفية.';
export const MSG_EMPTY_SEARCH_FILTERED =
  'لا توجد ملفات تطابق البحث مع عوامل التصفية الحالية.';
export const MSG_SEARCH_DIRECT_ONLY =
  'يشمل البحث ملفات هذا المجلد المباشرة فقط، لا مجلداته الفرعية.';
export const MSG_EMPTY_LIBRARY = 'ارفع ملفات إلى أحد المجلدات لتظهر هنا.';
export const MSG_EMPTY_FILTERED = 'عدّل عوامل التصفية أو أزلها لعرض المزيد.';
export const MSG_SEARCH_MIN = (min: number) =>
  `اكتب ${countOf(min, CHARACTERS)} على الأقل للبحث`;

export const MSG_FILTER_SWITCHED_TO_ALL =
  'الجذر يحتوي مجلدات فقط، فعُرضت «كل الملفات» لتظهر الملفات المطابقة للتصفية.';

export const MSG_ITEMS_SELECTED = (count: number) =>
  `المحدد: ${countOf(count, ITEMS_NOMINATIVE)}`;
export const MSG_STATUS_ITEMS = (count: number) => countOf(count, ITEMS);
/** What a folder, the library or a selection holds; a kind it has none of is left out. */
export const MSG_CONTENTS = (folders: number, files: number) => {
  if (folders === 0 && files === 0) return 'فارغ';
  if (files === 0) return countOf(folders, FOLDERS_NOMINATIVE);
  if (folders === 0) return countOf(files, FILES_NOMINATIVE);
  return `${countOf(folders, FOLDERS_NOMINATIVE)} و${countOf(files, FILES_NOMINATIVE)}`;
};
export const MSG_SELECT_FOR_DETAILS = 'حدّد عنصراً لعرض تفاصيله هنا.';
export const MSG_PUBLIC_LINK_HINT = 'رابط دائم متاح لأي شخص على الإنترنت.';
export const MSG_PRIVATE_LINK_HINT =
  'الملف خاص: روابطه مؤقتة صالحة لساعة واحدة.';
export const MSG_PRIVATE_IMAGE = 'صورة خاصة، تظهر عند فتح التفاصيل';
export const MSG_IN_USE_LOCKED = 'لا يمكن حذف هذا الملف ما دام مستخدماً.';
export const MSG_UPLOADER_DELETED = 'حساب محذوف';
export const MSG_NOT_USED = 'غير مستخدم في أي سجل';
export const MSG_HIDDEN_USAGES = (count: number) =>
  `${countOf(count, OTHER_RECORDS)} في صفحات لا تملك صلاحية عرضها`;
export const MSG_MORE_USAGES = (count: number) =>
  `و${countOf(count, OTHER_RECORDS)} لا تتسع لها القائمة`;
export const MSG_SPLIT_WARNING = (batches: number) =>
  `أكثر من ${countOf(IDS_ARRAY_MAX, ITEMS)}: ستُقسَّم العملية إلى ${countOf(batches, BATCHES)}.`;
export const MSG_LOAD_MORE = (remaining: number) =>
  `تحميل المزيد (${remaining})`;
export const MSG_PREVIEW_FAILED = 'تعذّر تحميل المعاينة';
export const MSG_PREVIEW_UNAVAILABLE =
  'لا تتوفر معاينة لهذا الملف، نزّله لعرضه.';

export const MSG_SELECT_ONE_TO_RENAME = 'حدّد عنصراً واحداً لإعادة تسميته.';

export const MSG_CUT_READY = (count: number) =>
  `حُدِّد ${countOf(count, ITEMS_NOMINATIVE)} للنقل. افتح المجلد الهدف واضغط «لصق هنا».`;
export const MSG_CUT_CANCELLED = 'أُلغي النقل المعلّق.';
export const MSG_CUT_WAIT = 'انتظر حتى ينتهي النقل الجاري.';
export const MSG_CUT_FROM = (count: number, source: string) =>
  `${countOf(count, ITEMS_NOMINATIVE)} من «${source}»`;
export const MSG_CUT_SEVERAL_PLACES = 'عدة مواقع';
export const MSG_PASTE_NOTHING = 'لا توجد عناصر معلّقة للنقل.';
export const MSG_PASTE_OPEN_FOLDER = 'افتح مجلداً للصق.';
export const MSG_ALREADY_HERE = 'العناصر موجودة في هذا المجلد بالفعل.';
export const MSG_PASTE_FILES_NEED_FOLDER =
  'الملفات تُحفظ داخل مجلد دائماً، فافتح مجلداً للصق.';
export const MSG_PASTE_INTO = (name: string) => `لصق في «${name}»`;
export const MSG_PASTE_FOLDERS_ONLY = (folders: number, files: number) =>
  `الجذر يحتوي مجلدات فقط. سيُنقل ${countOf(folders, FOLDERS_NOMINATIVE)} إلى «${MSG_LIBRARY_ROOT}»، وتبقى ${countOf(files, FILES_NOMINATIVE)} معلّقة إلى أن تفتح مجلداً وتلصقها فيه.`;
export const MSG_MOVED = (count: number, name: string) =>
  `نُقل ${countOf(count, ITEMS_NOMINATIVE)} إلى «${name}».`;
export const MSG_MOVE_GONE = (count: number) =>
  `أُزيل من النقل ما لم يعد موجوداً: ${countOf(count, ITEMS_NOMINATIVE)}.`;
export const MSG_MOVE_SPLIT = (batches: number) =>
  `قُسِّم النقل إلى ${countOf(batches, BATCHES)}، فالحد ${countOf(IDS_ARRAY_MAX, ITEMS_NOMINATIVE)} في الطلب الواحد.`;
export const MSG_MOVE_TO = (count: number, name: string) =>
  `نقل ${countOf(count, ITEMS)} إلى «${name}»`;

// The delete dialog. A count stands only where the noun agrees for any number;
// elsewhere the names are listed and the sentence speaks of them in general.

/** One item by its name, several by how many. */
export const MSG_DELETE_TITLE = (count: number, name: string | undefined) =>
  name === undefined ? `حذف ${countOf(count, ITEMS)}` : `حذف «${name}»`;
export const MSG_DELETE_PERMANENT =
  'يُحذف نهائياً من المكتبة والتخزين، ولا يمكن استعادته بعد ذلك.';
export const MSG_AND_MORE = (count: number) =>
  `و${countOf(count, OTHER_ITEMS)}…`;
export const MSG_DELETE_CHECKING = 'جارٍ حساب ما سيُحذف…';
/** Said only when the folders hold more than what was selected. */
export const MSG_DELETE_TREE = (folders: number, files: number) =>
  `تُحذف المجلدات بكل ما بداخلها، والمجموع ${MSG_CONTENTS(folders, files)}.`;
export const MSG_DELETE_CHECK_FAILED = 'تعذّر حساب ما سيُحذف';
export const MSG_DELETE_CHECK_FAILED_HINT =
  'يمكنك المتابعة، فالخادم يتحقق من جديد عند الحذف.';
export const MSG_DELETE_TOO_LARGE = 'التحديد أكبر مما يُحذف دفعة واحدة';
export const MSG_DELETE_USED_FILES = 'ملفات مستخدمة في سجلات';
export const MSG_DELETE_USED_FILES_HINT =
  'لا يُحذف ملف ما دام مستخدماً، ويُرفض الطلب كله إن ضمّ أحدها.';
export const MSG_DELETE_USED_FOLDERS = 'مجلدات تضم ملفات مستخدمة';
export const MSG_DELETE_USED_FOLDERS_HINT =
  'لا يُحذف مجلد يضم ملفاً مستخدماً في سجل.';
export const MSG_DELETE_FINDING_FOLDERS = 'جارٍ تحديد المجلدات المعنية…';
export const MSG_DELETE_EXCLUDE = (count: number) =>
  `استبعادها من الحذف (${count})`;
export const MSG_DELETE_EXCLUDED = (count: number) =>
  `استُبعد من الحذف: ${countOf(count, ITEMS_NOMINATIVE)}`;
export const MSG_DELETE_BUSY = 'عناصر قيد المعالجة';
export const MSG_DELETE_BUSY_HINT =
  'بعض العناصر قيد الرفع أو تغيير الرؤية الآن، وقد يُرفض حذفها حتى تنتهي.';
export const MSG_DELETE_SPLIT = (batches: number) =>
  `يُرسل الحذف على ${countOf(batches, BATCHES)}، وكل دفعة تُحذف كاملةً أو لا يُحذف منها شيء.`;
export const MSG_DELETE_PROGRESS = (current: number, total: number) =>
  total > 1 ? `جارٍ الحذف، الدفعة ${current} من ${total}…` : 'جارٍ الحذف…';
export const MSG_DELETED_ITEMS = (count: number) =>
  `حُذف ${countOf(count, ITEMS_NOMINATIVE)} نهائياً.`;
export const MSG_DELETE_PARTLY = 'لم يُحذف كل شيء';
export const MSG_DELETE_REFUSED_IN_USE =
  'رُفض حذف دفعة لأنها تضم ملفات مستخدمة في سجلات، ولم يُحذف منها شيء.';
export const MSG_DELETE_REST = (count: number) => `حذف الباقي (${count})`;

export const MSG_PUBLISH_FILE = (name: string) =>
  `سيُنشر الملف «${name}» برابط دائم.`;
export const MSG_UNPUBLISH_FILE = (name: string) =>
  `سيعود الملف «${name}» خاصاً وتصبح روابطه مؤقتة.`;
export const MSG_PUBLISH_WARNING =
  'يصبح الملف متاحاً لأي شخص على الإنترنت. إلغاء النشر لاحقاً يمنع الوصول الجديد فقط، ولا يسحب نسخاً حفظتها المتصفحات، وتصل مدتها إلى سنة للصور.';
export const MSG_UNPUBLISH_WARNING =
  'لا يُلغى نشر ملف مستخدم في محتوى منشور، ولا تُسحب نسخ حفظتها المتصفحات قبل إلغاء النشر.';
export const MSG_LINK_COPIED_PERMANENT = 'تم نسخ الرابط الدائم';
export const MSG_LINK_COPIED_TEMPORARY =
  'تم نسخ رابط مؤقت صالح لساعة واحدة فقط، فالملف خاص';
export const MSG_DOWNLOAD_STARTED = (count: number) =>
  count > 1 ? `بدأ تنزيل ${countOf(count, FILES)}` : 'بدأ التنزيل';

export const MSG_UPLOAD_PICK_FOLDER =
  'الجذر يحتوي مجلدات فقط ولا يقبل ملفات. اختر مجلداً أو أنشئ مجلداً جديداً ثم ارفع إليه.';
export const MSG_PICK_FOLDER_FIRST = 'اختر المجلد الذي سيُنشأ بداخله أولاً.';
export const MSG_FOLDER_TREE_STARTED = (folders: number) =>
  `جارٍ إنشاء ${countOf(folders, FOLDERS)} ثم رفع الملفات.`;
export const MSG_FOLDER_TREE_FAILED = (reason: string) =>
  `تعذّر إنشاء بنية المجلدات: ${reason}`;
export const MSG_DROPPED_FOLDER_UNREADABLE = 'تعذّرت قراءة المجلد المُفلَت.';
export const MSG_DROP_TO_UPLOAD = 'أفلت الملفات للرفع';
export const MSG_DROP_INTO = (name: string) => `رفع إلى «${name}»`;
export const MSG_DROP_PICKS_FOLDER =
  'أفلت لاختيار مجلد الرفع، فالجذر لا يقبل ملفات';
export const MSG_UPLOADS_EMPTY =
  'لا توجد عمليات رفع. اسحب ملفات إلى أي مكان في المكتبة.';
export const MSG_UPLOAD_INTO = (name: string) => `إلى «${name}»`;
export const MSG_UPLOAD_CONVERTED_WEBP = (before: string, after: string) =>
  `حُوّل إلى WebP: ${before} ← ${after}`;
export const MSG_UPLOAD_STORED_PRIVATE = 'تم الرفع، والملف خاص';
export const MSG_UPLOAD_SVG_CONVERTED = 'حُوّل ملف SVG إلى صورة';
export const MSG_UPLOAD_WAITING = (seconds: number) =>
  `تجاوزت حد الرفع، يُعاد الرفع بعد ${countOf(seconds, SECONDS)}`;
export const MSG_UPLOAD_BATCH_DONE = (done: number, failed: number) => {
  if (failed === 0)
    return `رُفع ${countOf(done, FILES_NOMINATIVE)}. الملفات المرفوعة خاصة إلى أن تُنشر.`;
  if (done === 0) return `تعذّر رفع ${countOf(failed, FILES)}.`;
  return `رُفع ${countOf(done, FILES_NOMINATIVE)} وتعذّر رفع ${countOf(failed, FILES)}.`;
};
export const MSG_UPLOADS_LEAVE =
  'الرفع جارٍ، ومغادرة الصفحة توقفه وما لم يُرفع لا يُحفظ. هل تريد المغادرة؟';

export const MSG_RESULTS_IN_FOLDER = (query: string, folder: string) =>
  `نتائج «${query}» في «${folder}»`;
export const MSG_RESULTS_EVERYWHERE = (query: string) =>
  `نتائج «${query}» في المكتبة كلها`;
export const MSG_RTL_ARROWS =
  'في الواجهة العربية تنعكس أسهم اليمين واليسار: اليسار يدخل أعمق، واليمين يرجع.';

export const MSG_SESSIONS_REVOKED = (count: number) =>
  `تم إنهاء ${countOf(count, SESSIONS)}`;
export const MSG_SESSIONS_NONE_REVOKED =
  'لم تُنهَ أي جلسة. الجلسة الحالية لا تُنهى من هنا، وما سواها انتهى بالفعل.';
export const MSG_REVOKE_SELECTED_SESSIONS = (count: number) =>
  `ستُنهى ${countOf(count, SESSIONS)} ويُطلب من أصحابها تسجيل الدخول من جديد.`;
export const MSG_REVOKE_ALL_SESSIONS = (isSelf: boolean) =>
  isSelf
    ? 'ستُنهى كل الجلسات عدا الجلسة الحالية، وتُحذف الأجهزة الموثوقة فيُطلب التحقق بخطوتين عند الدخول التالي.'
    : 'ستُنهى كل جلسات هذا المستخدم، وتُحذف أجهزته الموثوقة فيُطلب منه التحقق بخطوتين عند دخوله التالي.';
export const MSG_USER_SESSIONS_INTRO =
  'الأجهزة المسجّل دخولها بحساب هذا المستخدم.';
export const MSG_NO_ACTIVE_SESSIONS = 'لا توجد جلسات نشطة';

export const MSG_TWO_FACTOR_RESET_INTRO =
  'لمستخدم فقد كل طرق التحقق ولا يستطيع الدخول بدونها.';
export const MSG_TWO_FACTOR_RESET_EFFECTS =
  'تُحذف كل طرق التحقق لهذا المستخدم: تطبيق المصادقة ورموزه الاحتياطية ومفاتيح المرور (Passkey) والرمز المرسل، وتُحذف أجهزته الموثوقة، وتُنهى كل جلساته فيخرج من حسابه فوراً.';
export const MSG_TWO_FACTOR_RESET_WARNING =
  'يدخل في المرة التالية بكلمة المرور وحدها دون أي تحقق، وتضيع رموزه الاحتياطية ومفاتيح المرور نهائياً. لا تتابع قبل أن تتأكد من هويته.';
export const MSG_TWO_FACTOR_RESET_SELF =
  'هذا حسابك: ستخرج من هذه الجلسة أيضاً.';
export const MSG_TWO_FACTOR_RESET_DONE =
  'أُعيد تعيين التحقق بخطوتين وأُنهيت كل جلسات المستخدم';

export const MSG_ACCOUNT_PAGE = 'الصفحة الشخصية';
export const MSG_USER_SELF_EDIT =
  'تعديل حسابك يتم من الصفحة الشخصية: الاسم وكلمة المرور والبريد الإلكتروني والتحقق بخطوتين.';
export const MSG_COPIED = 'تم النسخ';
export const MSG_COPY_FAILED = 'تعذّر النسخ، انسخ النص يدوياً';
export const MSG_CODE_SENT_TO = 'أُرسل رمز التحقق إلى';
export const MSG_CODE_WILL_GO_TO = 'سيُرسل رمز التحقق إلى';
export const MSG_NO_PHONE = 'لا يوجد رقم هاتف في حسابك';
export const MSG_EMAIL_CHANGE_EFFECT =
  'يصلك رمز على البريد الجديد، وبعد تأكيده تُنهى جلساتك على كل الأجهزة، ومنها هذه، وتُحذف أجهزتك الموثوقة، فتسجّل الدخول من جديد.';
export const MSG_EMAIL_CHANGED_SIGN_IN_AGAIN =
  'أُنهيت جلساتك على كل الأجهزة، ومنها هذه. سجّل الدخول من جديد بالبريد الإلكتروني الجديد.';
export const MSG_PHONE_CHANGE_EFFECT =
  'يصلك رمز على الرقم الجديد، وبعد تأكيده تُنهى جلساتك على الأجهزة الأخرى وتُحذف أجهزتك الموثوقة، وتسقط طريقة التحقق بخطوتين المرتبطة بالرقم القديم فتضيفها من جديد.';
export const MSG_PASSWORD_CHANGE_EFFECT =
  'عند التغيير تُنهى جلساتك على الأجهزة الأخرى وتبقى هذه الجلسة وأجهزتك الموثوقة.';

export const MSG_TWO_FACTOR_INTRO =
  'يطلب الدخول رمزاً ثانياً بعد كلمة المرور. أضف أكثر من طريقة حتى لا تفقد الوصول إن ضاعت إحداها.';
export const MSG_TWO_FACTOR_NONE =
  'لا توجد طرق تحقق بعد. أضف طريقة لتفعيل التحقق بخطوتين.';
export const MSG_TWO_FACTOR_REMOVE_EFFECT =
  'ستُزال هذه الطريقة وتُحذف كل أجهزتك الموثوقة، فيُطلب التحقق بخطوتين عند الدخول التالي على كل جهاز.';
export const MSG_TWO_FACTOR_DISABLE_EFFECT =
  'ستُحذف كل طرق التحقق وأجهزتك الموثوقة، وتصبح كلمة المرور وحدها كافية للدخول. تبقى مفاتيح المرور في قائمتك.';
export const MSG_DEFAULT_METHOD_SET = 'تم تعيين الطريقة الافتراضية';
export const MSG_ENROL_SIGNS_OUT_OTHERS =
  'عند تفعيل أي طريقة تُنهى جلساتك على الأجهزة الأخرى.';
export const MSG_ADD_TOTP =
  'رمز يتجدد باستمرار في تطبيق على هاتفك، مثل Google Authenticator.';
export const MSG_ADD_OTP_EMAIL = 'رمز يصل إلى بريدك الإلكتروني عند كل دخول.';
export const MSG_ADD_OTP_PHONE = 'رمز يصل إلى هاتفك عند كل دخول.';
export const MSG_ADD_BACKUP_CODES =
  'رموز تُستعمل مرة واحدة لدخول طارئ إن فقدت الطرق الأخرى.';
export const MSG_TOTP_SCAN =
  'امسح الرمز بتطبيق المصادقة، أو أدخل المفتاح فيه يدوياً.';
export const MSG_TOTP_SECRET = 'المفتاح';
export const MSG_TOTP_ENTER_CODE = 'الرمز الظاهر في التطبيق';
export const MSG_BACKUP_CODES_UNACKNOWLEDGED =
  'لا تعمل هذه الرموز قبل أن تؤكّد حفظها، وتبطل الرموز السابقة فور إنشاء مجموعة جديدة.';
export const MSG_BACKUP_CODES_ONCE =
  'تُعرض الرموز مرة واحدة فقط ولا يمكن عرضها مرة أخرى. احفظها في مكان آمن.';
export const MSG_BACKUP_CODES_ACKNOWLEDGE = 'حفظتُ هذه الرموز في مكان آمن';
export const MSG_BACKUP_CODES_RENEW_EFFECT =
  'تبطل رموزك الاحتياطية الحالية فور إنشاء المجموعة الجديدة، ولا تعمل الجديدة قبل أن تؤكّد حفظها.';
export const MSG_BACKUP_CODES_LEAVE =
  'الرموز الاحتياطية الجديدة لم تُحفظ بعد ولا يمكن عرضها مرة أخرى، وقد أُبطلت الرموز السابقة. هل تغادر الصفحة؟';
export const MSG_PASSKEYS_INTRO =
  'تحقق بالبصمة أو الوجه أو رمز الجهاز. تبقى مفاتيحك محفوظة عند إيقاف التحقق بخطوتين.';
export const MSG_NO_PASSKEYS = 'لا توجد مفاتيح مرور بعد.';
export const MSG_PASSKEY_ADDED = 'تمت إضافة مفتاح المرور';
export const MSG_PASSKEY_DELETED = 'تم حذف مفتاح المرور';
export const MSG_PASSKEY_DELETE_EFFECT =
  'سيُحذف مفتاح المرور من حسابك. إن كان آخر مفتاح وكان طريقة تحقق، فتُزال الطريقة وتُحذف أجهزتك الموثوقة.';
export const MSG_PASSKEY_ENROL_PROMPT =
  'يطلب المتصفح بصمتك أو وجهك أو رمز جهازك لحفظ المفتاح.';
export const MSG_PASSKEY_NAME_HINT = 'اختياري، يساعدك على التمييز بين مفاتيحك.';
export const MSG_TRUSTED_DEVICES_INTRO =
  'أجهزة لا يُطلب منك فيها التحقق بخطوتين عند الدخول. يسقط الجهاز إن لم يُستعمل مدة طويلة، ويمكنك إزالته في أي وقت.';
export const MSG_NO_TRUSTED_DEVICES = 'لا توجد أجهزة موثوقة.';
export const MSG_DEVICE_REVOKED = 'تمت إزالة الجهاز';

export const MSG_OWN_ROLE_READ_ONLY = 'تُعرض الصلاحية هنا للقراءة فقط.';

// The permission matrix. Page and action names are the shared labels; the
// verbs are its columns, each holding one action or its own-records variant.

const ACTION = PERMISSION_ACTION_LABELS;

// Nominative: «تغيّرت …».
const CELLS_NOMINATIVE: CountForms = {
  one: 'خلية واحدة',
  two: 'خليتان',
  few: '# خلايا',
  many: '# خلية',
  other: '# خلية',
};

export const PERMISSION_VERB_LABELS = {
  view: 'عرض',
  edit: 'تعديل',
  delete: 'حذف',
  create: ACTION.create,
  special: 'إجراءات خاصة',
} as const;

/** By level: nothing, the records the user created, every record. */
export const PERMISSION_SCOPE_LABELS = ['لا شيء', 'الخاص', 'الكل'] as const;
export const PERMISSION_SCOPE_PHRASES = [
  PERMISSION_SCOPE_LABELS[0],
  'الخاص فقط',
  PERMISSION_SCOPE_LABELS[2],
] as const;
export const MSG_PERM_ALLOWED = 'مسموح';
export const MSG_PERM_ON = 'مفعّل';
export const MSG_PERM_OFF = 'غير مفعّل';

export const MSG_PERM_GRID =
  'مصفوفة الصلاحيات: الصفحات في الصفوف والإجراءات في الأعمدة';
export const MSG_PERM_PAGE_COLUMN = 'الصفحة';
export const MSG_PERM_APPLY_ALL_PAGES = 'تطبيق على كل الصفحات:';
export const MSG_PERM_NOT_OFFERED = 'غير متاح لهذه الصفحة';
export const MSG_PERM_LOCKED = 'لا تملك هذه الصلاحية، فلا يمكنك منحها';
export const MSG_PERM_ALL_LOCKED = `خيار «${PERMISSION_SCOPE_LABELS[2]}» مقفل: ${MSG_PERM_LOCKED}`;
export const MSG_PERM_PREREQUISITE_TAG = 'شرط لازم';
export const MSG_PERM_DEPENDENT_TAG = 'يعتمد عليه';

export const MSG_PERM_CELL = (verb: string, page: string, state: string) =>
  `${verb} ${page}: ${state}`;
export const MSG_PERM_SPECIAL_CELL = (
  action: string,
  page: string,
  on: boolean
) => `${action} — ${page}: ${on ? MSG_PERM_ON : MSG_PERM_OFF}`;

export const MSG_PERM_PREREQUISITES = {
  create: `الإنشاء لا يتطلب «${PERMISSION_VERB_LABELS.view}»: يمكن إنشاء سجلات دون القدرة على رؤيتها.`,
  requiresView: (option: string) => `«${option}» يتطلب «${ACTION.view}».`,
  none: 'لا يتطلب أي صلاحية أخرى.',
  viewAlone: 'لا شيء يعتمد على هذا الخيار.',
  viewDependents: (withPublish: boolean) =>
    `التعديل والحذف${withPublish ? ' والنشر' : ''} يعتمدان على العرض؛ خفض العرض يخفضها تلقائياً.`,
  scoped: `«${PERMISSION_SCOPE_LABELS[2]}» يتطلب «${ACTION.view}»، و«${PERMISSION_SCOPE_LABELS[1]}» يتطلب «${ACTION.viewOwn}» أو «${ACTION.view}».`,
  binary: `يتطلب «${PERMISSION_VERB_LABELS.view}».`,
} as const;

export const MSG_PERM_OPTION_LOCKED = (option: string) =>
  `«${option}» غير متاح: ${MSG_PERM_LOCKED}`;
export const MSG_PERM_STUCK = (option: string) =>
  `«${option}»: ${MSG_PERM_LOCKED}`;
export const MSG_PERM_VIEW_LOCKED = (option: string, view: string) =>
  `تعذّر منح «${option}» لأنه يتطلب «${view}» وهو غير متاح لك`;

/** Why a write raised the page's view, by the write that needed it. */
export const PERMISSION_RAISE_CAUSES = {
  editAll: 'التعديل على الكل',
  editOwn: 'تعديل الخاص',
  deleteAll: 'الحذف على الكل',
  deleteOwn: 'حذف الخاص',
  publish: 'النشر',
} as const;
export const MSG_PERM_VIEW_RAISED = (
  view: string,
  cause: string,
  page: string
) => `فُعِّل «${view}» لأن ${cause} يتطلبه — ${page}`;
export const MSG_PERM_REVOKED = (option: string) => `أُلغي «${option}»`;
export const MSG_PERM_LOWERED_TO = (from: string, to: string) =>
  `خُفِّض «${from}» إلى «${to}»`;
export const MSG_PERM_DEPENDENTS_ADJUSTED = (
  view: string,
  page: string,
  changes: readonly string[]
) =>
  `بعد تخفيض «${view}» في ${page} عُدِّلت الصلاحيات المعتمدة عليه: ${changes.join('، ')}.`;

export const MSG_PERM_GRANT_ALL = 'منح الكل';
export const MSG_PERM_CLEAR_ALL = 'إزالة الكل';
export const MSG_PERM_GRANT_ROW = (page: string) =>
  `${MSG_PERM_GRANT_ALL} في «${page}» (ما تملكه فقط)`;
export const MSG_PERM_COMPLETE_ROW = (page: string) =>
  `${MSG_PERM_GRANT_ALL} في «${page}»: إكمال ما تبقّى (ما تملكه فقط)`;
export const MSG_PERM_CLEAR_ROW = (page: string) =>
  `${MSG_PERM_CLEAR_ALL} من «${page}»`;
export const MSG_PERM_ROW_STATE = (
  page: string,
  tip: string,
  granted: number,
  total: number
) => `${page}: ${tip}. الحالة: ${granted} من ${total}`;
export const MSG_PERM_ROW_GRANTED = (page: string, changed: number) =>
  `${MSG_PERM_GRANT_ALL} في «${page}»: تغيّر ${changed} من الخيارات.`;
export const MSG_PERM_ROW_CLEARED = (page: string, changed: number) =>
  `${MSG_PERM_CLEAR_ALL} من «${page}»: أُزيل ${changed} من الخيارات.`;
export const MSG_PERM_NOT_GRANTED = (options: readonly string[]) =>
  `لم يُمنح لأنك لا تملكه: ${options.join('، ')}.`;
export const MSG_PERM_NOT_GRANTED_ON = (page: string, option: string) =>
  `${page} («${option}»)`;
export const MSG_PERM_NOTHING_TO_CHANGE =
  'لا يوجد ما يمكن تغييره هنا بصلاحياتك الحالية';

export const PERMISSION_TRI_STATE_LABELS = {
  none: PERMISSION_SCOPE_LABELS[0],
  mixed: 'جزئي',
  all: 'مكتمل',
} as const;
export const MSG_PERM_COLUMN_STATE = (
  verb: string,
  action: string,
  state: string
) => `${verb}: ${action} في كل الصفحات. الحالة: ${state}`;
export const MSG_PERM_COLUMN_TIP = (action: string, verb: string) =>
  `${action}: «${verb}» في كل الصفحات التي تدعمه — للخيارات اضغط السهم الصغير`;
export const MSG_PERM_COLUMN_KEYS = 'للخيارات: Alt+السهم لأسفل';
export const MSG_PERM_COLUMN_MENU = (verb: string) =>
  `خيارات تطبيق «${verb}» على كل الصفحات`;
export const MSG_PERM_COLUMN_MENU_TITLE = (verb: string) =>
  `تطبيق «${verb}» على كل الصفحات`;
export const MSG_PERM_COLUMN_CLEAR = 'إزالته من كل الصفحات';
export const MSG_PERM_COLUMN_GRANT = 'لكل الصفحات التي تدعمه (ما تملكه فقط)';
export const MSG_PERM_COLUMN_GRANT_BINARY =
  'منحه لكل صفحة تدعمه (ما تملكه فقط)';
export const MSG_PERM_COLUMN_OWN = (
  applies: readonly string[],
  skips: readonly string[]
) =>
  `ينطبق على: ${applies.join('، ')}${skips.length > 0 ? ` — لا ينطبق على: ${skips.join('، ')}` : ''}`;
export const MSG_PERM_COLUMN_SKIPPED = (page: string) =>
  `تخطّي «${page}»: لا يوجد فيها نطاق «${PERMISSION_SCOPE_LABELS[1]}».`;
export const MSG_PERM_COLUMN_APPLIED = (
  verb: string,
  choice: string,
  changed: number
) =>
  `تطبيق «${verb}: ${choice}» على كل الصفحات: تغيّرت ${countOf(changed, CELLS_NOMINATIVE)}.`;
export const MSG_PERM_COLUMN_GRANTED = 'منح';
export const MSG_PERM_COLUMN_CLEARED = 'إزالة';
export const MSG_PERM_COLUMN_UNCHANGED =
  'لا تغيير: كل الصفحات على هذا الخيار بالفعل';

export const MSG_PERM_LEVEL_NONE = 'بدون هذه الصلاحية';
export const MSG_PERM_LEVEL_ALL = 'كل السجلات، ويشمل الخاص';
export const MSG_PERM_UNDO = MSG_UNDO;
export const MSG_PERM_UNDONE = 'تم التراجع';

export const MSG_PERM_SUMMARY_SWITCH = 'الملخص';
export const MSG_PERM_EMPTY_PAGE = 'لا يملك أي صلاحية على هذه الصفحة';

interface SummaryFragments {
  /** The page's records as an attached object pronoun: «ويعدّلهم». */
  pronoun: string;
  create: string;
  special?: string;
  /** Whether create joins the «all» clause («ويُنشئهم») or stands alone. */
  createJoins: boolean;
}

/** What a page's own-records level reaches: what the user created or uploaded. */
const OWN_RECORDS: Record<DashboardPage, string> = {
  home: 'ما أنشأه',
  users: 'ما أنشأه',
  permissions: 'ما أنشأه',
  media: 'ما رفعه',
};

/** `null` for a page whose only action is view. */
const SUMMARY_FRAGMENTS: Record<DashboardPage, SummaryFragments | null> = {
  home: null,
  users: {
    pronoun: 'هم',
    create: 'يُنشئ مستخدمين جدداً',
    special: 'يعيد تعيين التحقق بخطوتين',
    createJoins: true,
  },
  permissions: {
    pronoun: 'ها',
    create: 'يُنشئ صلاحيات جديدة',
    createJoins: true,
  },
  media: {
    pronoun: 'ها',
    create: 'يرفع ملفات جديدة',
    special: 'ينشر الملفات',
    createJoins: false,
  },
};

const SUMMARY_VERBS = { view: 'يعرض', edit: 'يعدّل', delete: 'يحذف' } as const;
const SUMMARY_CREATE = 'يُنشئ';

/** What an own-records option reaches on `page`, for its menu. */
export const MSG_PERM_LEVEL_OWN = (page: DashboardPage) =>
  `${OWN_RECORDS[page]} المستخدم فقط`;

/** One page's levels: 0 none, 1 own records, 2 all; `special` is 0 or 2. */
export interface PageSummaryLevels {
  view: number;
  edit: number;
  delete: number;
  create: number;
  special: number;
  /** View has an own-records level, so «all» is worth saying. */
  viewScoped: boolean;
  offersDelete: boolean;
}

/** The page's grants as one plain sentence. */
export function MSG_PERM_PAGE_SUMMARY(
  page: DashboardPage,
  levels: PageSummaryLevels
): string {
  const noun = DASHBOARD_PAGE_LABELS[page];
  const fragments = SUMMARY_FRAGMENTS[page];
  if (!fragments)
    return levels.view ? `${SUMMARY_VERBS.view} ${noun}` : MSG_PERM_EMPTY_PAGE;

  const all: (keyof typeof SUMMARY_VERBS)[] = [];
  const own: (keyof typeof SUMMARY_VERBS)[] = [];
  for (const verb of ['view', 'edit', 'delete'] as const) {
    if (levels[verb] === 2) all.push(verb);
    else if (levels[verb] === 1) own.push(verb);
  }

  const pieces: string[] = [];
  let createSaid = false;
  const [first, ...rest] = all;
  if (first) {
    let text =
      first === 'view' && !levels.viewScoped
        ? `${SUMMARY_VERBS.view} ${noun}`
        : `${SUMMARY_VERBS[first]} كل ${noun}`;
    for (const verb of rest)
      text += ` و${SUMMARY_VERBS[verb]}${fragments.pronoun}`;
    if (levels.create && fragments.createJoins) {
      text += ` و${SUMMARY_CREATE}${fragments.pronoun}`;
      createSaid = true;
    }
    pieces.push(text);
  }
  if (!createSaid && levels.create) pieces.push(fragments.create);
  if (own.length > 0) {
    const verbs = own
      .map((verb, i) => (i ? 'و' : '') + SUMMARY_VERBS[verb])
      .join(' ');
    pieces.push(
      `${verbs} ${OWN_RECORDS[page]}${all.length > 0 ? '' : ` من ${noun}`} فقط`
    );
  }
  if (levels.special && fragments.special) pieces.push(fragments.special);
  if (pieces.length === 0) return MSG_PERM_EMPTY_PAGE;

  let text = pieces.map((piece, i) => (i ? 'و' : '') + piece).join('، ');
  // Create needs no view, so say when a role can create what it cannot see.
  if (levels.create && !levels.view) text += `، دون أن يعرض ${noun}`;
  else if (levels.offersDelete && !levels.delete) text += '، دون حذف';
  return text;
}

export const MSG_PERM_SHORTCUTS = 'اختصارات لوحة المفاتيح';
export const PERMISSION_MATRIX_SHORTCUTS: readonly {
  keys: readonly string[];
  text: string;
}[] = [
  {
    keys: ['←', '→', '↑', '↓'],
    text: 'التنقل بين الخلايا (← للعمود التالي و→ للسابق في العربية)',
  },
  { keys: ['Home', 'End'], text: 'أول الصف / آخره' },
  {
    keys: ['Space', 'Enter'],
    text: 'الخيار التالي: لا شيء ← الخاص ← الكل (وعلى رأس العمود: منح الكل / إزالة الكل)',
  },
  {
    keys: ['Shift+Space'],
    text: 'الخيار السابق (أو النقر الأيمن / Shift + نقرة)',
  },
  { keys: ['0', '1', '2'], text: 'لا شيء / الخاص / الكل مباشرة' },
  { keys: ['Alt+↓'], text: 'فتح قائمة الخيارات للخلية أو للعمود' },
  { keys: ['Mod+Z'], text: 'التراجع عن آخر تغيير في الجدول' },
  { keys: ['?'], text: 'إظهار / إخفاء هذه القائمة' },
];
