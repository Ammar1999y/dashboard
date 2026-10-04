import {
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_NOT_FOUND,
  MSG_UNTRUSTED_ORIGIN,
  MSG_UPDATE_ERROR,
} from './common';
import { otpMsg } from './otp';
import { MSG_INSUFFICIENT_PERMISSIONS } from './permissions';
import { userMsg } from './users';

export const MSG_LOGIN_REQUIRED = 'قم بتسجيل الدخول أولاً';
export const MSG_INVALID_CREDENTIALS = 'البيانات المدخلة غير صحيحة';
export const MSG_EMAIL_NOT_VERIFIED =
  'يجب تفعيل البريد الإلكتروني قبل تسجيل الدخول';
export const MSG_PHONE_NOT_VERIFIED = 'يجب تفعيل رقم الهاتف قبل تسجيل الدخول';
export const MSG_REAUTH_GRANTED = 'تم تأكيد كلمة المرور';
export const MSG_REAUTH_REQUIRED =
  'هذا الإجراء يتطلب تأكيد كلمة المرور. أعد إدخال كلمة المرور ثم حاول مرة أخرى';
export const MSG_PASSWORD_COMPROMISED =
  'هذه الكلمة مستخدمة بكثرة أو مُسرّبة سابقًا، لذلك لا تُعد آمنة. يرجى اختيار كلمة مرور مختلفة.';

// The user is already known here, so these need not collapse like `otpMsg`.
export const twoFactorMsg = {
  challengeMissing: 'انتهت جلسة التحقق. يرجى تسجيل الدخول من جديد',
  methodUnavailable: 'طريقة التحقق غير متاحة لحسابك',
  contactUnverified: 'يجب تأكيد وسيلة التواصل قبل استخدامها للتحقق بخطوتين',
  codeSent: 'تم إرسال رمز التحقق',
  sendError: otpMsg.sendError,
  invalidCode: otpMsg.invalidOrExpired,
  tooManyAttempts: 'تجاوزت عدد المحاولات. يرجى تسجيل الدخول من جديد',
  enabled: 'تم تفعيل التحقق بخطوتين',
  disabled: 'تم إلغاء تفعيل طريقة التحقق',
  lastMethod:
    'لا يمكن إزالة طريقة التحقق الوحيدة. قم بإلغاء تفعيل التحقق بخطوتين بدلاً من ذلك',
  verifySuccess: 'تم التحقق بنجاح',
  trustRequiresProof:
    'يجب إكمال التحقق بخطوتين على هذا الجهاز قبل حفظه كجهاز موثوق',
  totpEnrolmentExpired:
    'انتهت مهلة إعداد تطبيق المصادقة. يرجى بدء الإعداد من جديد',
  totpAlreadyEnrolled:
    'يوجد تطبيق مصادقة مُفعّل بالفعل. قم بإزالته أولاً قبل إضافة تطبيق جديد',
  passkeyNotUserVerifying:
    'هذا الجهاز لا يطلب التحقق من هويتك (بصمة أو رمز)، فلا يصلح كوسيلة تحقق ثانية. استخدم جهازاً يدعم التحقق البيومتري أو رمز PIN',
  contactChangeStrands:
    'لا يمكن تغيير وسيلة التواصل لأن ذلك سيُفقد الحساب طريقة التحقق بخطوتين الوحيدة. أعد تعيين التحقق بخطوتين للحساب أولاً',
  twoFactorUnavailable:
    'تعذّر إكمال التحقق بخطوتين: لا توجد طريقة تحقق متاحة على حسابك حالياً. تواصل مع الدعم لاستعادة الوصول',
  // Distinct because the fix differs: retry, versus delete the dead key first.
  passkeyNotSaved:
    'لم يُحفظ مفتاح المرور، ولم يتم تفعيل التحقق بخطوتين. أعد تسجيل مفتاح المرور',
  passkeyNotEnrolled:
    'تم حفظ مفتاح المرور لكن تعذّر تفعيله كوسيلة تحقق ثانية. احذفه من قائمة مفاتيح المرور ثم سجّله من جديد',
  staleBackupSet:
    'الرموز الاحتياطية التي تؤكّد حفظها لم تعد هي الحالية. تم توليد مجموعة أحدث؛ اعرضها واحفظها ثم أكّد حفظها',
} as const;

const MSG_RETRY_OR_RELOAD = 'حاول مجدداً، أو أعد تحميل الصفحة';
const MSG_USER_ALREADY_EXISTS =
  'المستخدم موجود بالفعل، استخدم بريداً إلكترونياً آخر لإنشاء الحساب';

/**
 * Better Auth's own error codes, localised by the `after` hook and by `app.ts`.
 * A key that is also one of this project's routing codes keeps that code on the
 * wire (`localisedAuthBody`), so its value must be the message the project
 * raises it with.
 */
export const betterAuthMsg: Readonly<Record<string, string>> = {
  USER_NOT_FOUND: 'المستخدم غير موجود',
  FAILED_TO_CREATE_USER:
    'حدث خطأ ما في عملية إنشاء المستخدم، حاول مجدداً، أو أعد تحميل الصفحة',
  FAILED_TO_CREATE_SESSION:
    'حدث خطأ ما في عملية إنشاء الجلسة، حاول مجدداً، أو أعد تحميل الصفحة',
  FAILED_TO_UPDATE_USER:
    'حدث خطأ ما في عملية تحديث المستخدم، حاول مجدداً، أو أعد تحميل الصفحة',
  FAILED_TO_GET_SESSION:
    'حدث خطأ ما في عملية الحصول على بيانات الجلسة، حاول مجدداً، أو أعد تحميل الصفحة',
  INVALID_PASSWORD: 'كلمة المرور غير صحيحة',
  INVALID_EMAIL: 'البريد الإلكتروني غير صحيح',
  INVALID_EMAIL_OR_PASSWORD: MSG_INVALID_CREDENTIALS,
  INVALID_TOKEN: MSG_RETRY_OR_RELOAD,
  FAILED_TO_GET_USER_INFO:
    'حدث خطأ ما في عملية الحصول على بيانات المستخدم، حاول مجدداً، أو أعد تحميل الصفحة',
  USER_EMAIL_NOT_FOUND: 'البريد الإلكتروني غير موجود',

  SOCIAL_ACCOUNT_ALREADY_LINKED: 'هذا الحساب الخارجي مرتبط بالفعل',
  PROVIDER_NOT_FOUND: 'مزود تسجيل الدخول غير متاح',
  ID_TOKEN_NOT_SUPPORTED: 'مزود تسجيل الدخول لا يدعم هذه الطريقة',
  PASSWORD_TOO_SHORT: 'كلمة المرور قصيرة جداً',
  PASSWORD_TOO_LONG: 'كلمة المرور طويلة جداً',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'لا يوجد حساب بكلمة مرور لهذا المستخدم',
  USER_ALREADY_HAS_PASSWORD:
    'هذا الحساب يملك كلمة مرور بالفعل، أدخلها لحذف الحساب',
  FAILED_TO_UNLINK_LAST_ACCOUNT: 'لا يمكن إلغاء ربط آخر حساب مرتبط بك',

  EMAIL_NOT_VERIFIED: MSG_EMAIL_NOT_VERIFIED,
  EMAIL_CAN_NOT_BE_UPDATED: 'لا يمكن تحديث البريد الإلكتروني',
  SESSION_EXPIRED: 'قم بإعادة تسجيل الدخول',
  SESSION_NOT_FRESH: 'مضى وقت طويل على تسجيل دخولك، قم بتسجيل الدخول مرة أخرى',
  ACCOUNT_NOT_FOUND: 'الحساب غير موجود',

  // ⚠️ `trustedOrigins` is unset, so a cross-origin front-end gets 403 on every
  // sign-in despite `CORS_POLICY`; set it if the front-end moves origin.
  INVALID_ORIGIN: MSG_UNTRUSTED_ORIGIN,
  MISSING_OR_NULL_ORIGIN: MSG_UNTRUSTED_ORIGIN,
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: MSG_UNTRUSTED_ORIGIN,

  // No `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED`: `POST /get-session` is
  // answered 405 by `app.ts` from `BETTER_AUTH_ENDPOINTS` before Better Auth runs.

  USER_ALREADY_EXISTS: MSG_USER_ALREADY_EXISTS,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: MSG_USER_ALREADY_EXISTS,

  // `tests/integration/auth-error-localisation.test.ts` fails if another
  // unmapped code becomes reachable.
  VALIDATION_ERROR: MSG_INVALID_INPUT,
  BAD_REQUEST: MSG_INVALID_INPUT,

  MISSING_RESPONSE: otpMsg.captchaFailed,
  VERIFICATION_FAILED: otpMsg.captchaFailed,
  UNKNOWN_ERROR: MSG_RETRY_OR_RELOAD,

  // The verifiers and passkey endpoints this deployment mounts. Most sit behind
  // a gate that answers first (`path-policy.ts`, the challenge check), so they
  // are reached only by a race or by a later library change.
  // `tests/integration/auth-error-localisation.test.ts` fails when a code the
  // two plugins declare is neither here nor accounted for.
  UNAUTHORIZED: MSG_LOGIN_REQUIRED,
  SESSION_REQUIRED: MSG_LOGIN_REQUIRED,
  INVALID_CODE: twoFactorMsg.invalidCode,
  INVALID_BACKUP_CODE: twoFactorMsg.invalidCode,
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: twoFactorMsg.tooManyAttempts,
  ACCOUNT_TEMPORARILY_LOCKED: userMsg.accountTemporarilyLocked,
  TOTP_NOT_ENABLED: twoFactorMsg.methodUnavailable,
  BACKUP_CODES_NOT_ENABLED: twoFactorMsg.methodUnavailable,
  TWO_FACTOR_NOT_ENABLED: twoFactorMsg.methodUnavailable,
  INVALID_TWO_FACTOR_COOKIE: twoFactorMsg.challengeMissing,
  FAILED_TO_INVALIDATE_TWO_FACTOR_CHALLENGE: MSG_INTERNAL_ERROR,
  CHALLENGE_NOT_FOUND: twoFactorMsg.passkeyNotSaved,
  FAILED_TO_VERIFY_REGISTRATION: twoFactorMsg.passkeyNotSaved,
  YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: MSG_INSUFFICIENT_PERMISSIONS,
  PASSKEY_NOT_FOUND: MSG_NOT_FOUND,
  FAILED_TO_UPDATE_PASSKEY: MSG_UPDATE_ERROR,
};
