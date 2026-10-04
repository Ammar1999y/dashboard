export const MSG_INTERNAL_ERROR = 'حدث خطأ في الخادم';

export const MSG_PAGE_NOT_FOUND = 'الصفحة غير موجودة';
export const MSG_METHOD_NOT_ALLOWED = 'الطلب غير مدعوم لهذا المسار';
export const MSG_NOT_FOUND = 'البيانات غير موجودة';
export const MSG_INVALID_INPUT = 'قم بالتحقق من البيانات المدخلة';

export const MSG_FETCHED = 'تم جلب البيانات بنجاح';
export const MSG_CREATED = 'تم الإنشاء بنجاح';
export const MSG_UPDATED = 'تم التحديث بنجاح';
export const MSG_DELETED = 'تم الحذف بنجاح';

export const MSG_FETCH_ERROR = 'حدث خطأ في جلب البيانات';
export const MSG_CREATE_ERROR = 'حدث خطأ في الإنشاء';
export const MSG_UPDATE_ERROR = 'حدث خطأ في التحديث';
export const MSG_DELETE_ERROR = 'حدث خطأ في الحذف';

export const MSG_TOO_MANY_REQUESTS = 'طلبات كثيرة جدًا، حاول مرة أخرى لاحقًا';

export const MSG_BODY_TOO_LARGE = 'حجم البيانات المرسلة أكبر من المسموح به';

export const MSG_MISSING_CLIENT_IP = 'لا يمكن تحديد عنوان الاتصال للطلب';

export const MSG_UNTRUSTED_ORIGIN =
  'تعذر إكمال الطلب من هذا الموقع. أعد تحميل الصفحة من الرابط الرسمي ثم حاول مرة أخرى.';

export const MSG_SERVICE_UNAVAILABLE =
  'الخدمة غير متاحة مؤقتًا، حاول مرة أخرى بعد قليل';

// Not in `auth.ts`: `otpMsg` quotes it and `auth.ts` imports `otp.ts`, so it
// would be a load-time cycle.
export const MSG_LOGIN_SUCCESS = 'تم تسجيل الدخول بنجاح';
