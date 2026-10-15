import type { ContactKind, OtpPurpose } from '../validation/enums';

import { OTP_EXPIRY_MINUTES } from '../validation/constants';
import { MSG_LOGIN_SUCCESS } from './common';
import { countOf, HOURS, MINUTES, SECONDS } from './count';

export const MSG_CHANNEL_DISABLED = 'طريقة الإرسال غير مسموحة حالياً';

export const otpMsg = {
  sendSuccess: 'تم إرسال رمز التحقق بنجاح',
  sendError: 'حدث خطأ أثناء إرسال رمز التحقق',
  smsSendError: 'حدث خطأ أثناء إرسال رمز التحقق عبر SMS',
  emailSendError: 'حدث خطأ أثناء إرسال رمز التحقق عبر البريد الإلكتروني',
  resendWait: (seconds: number) =>
    `يرجى الانتظار ${countOf(seconds, SECONDS)} قبل إعادة الإرسال`,
  sendBlocked: (contact: string, hours: number) =>
    `تجاوزت الحد الأقصى من المحاولات. تم حظر ${contact} لمدة ${countOf(hours, HOURS)}`,
  verifySuccess: (channel: string) =>
    channel === 'email'
      ? 'تم التحقق من البريد الإلكتروني بنجاح'
      : 'تم التحقق من رقم الهاتف بنجاح',
  verifyError: 'حدث خطأ أثناء التحقق من الرمز',
  invalidOrExpired: 'رمز التحقق غير صحيح أو منتهي الصلاحية',
  codeNotSent: 'لم يتم إرسال رمز التحقق. يرجى طلب رمز جديد',
  codeExpired: 'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد',
  codeIncorrect: 'رمز التحقق غير صحيح',
  // Promises that a new code lifts the block: `VERIFY_BLOCK_CLEARED_BY_RESEND`.
  verifyBlocked:
    'تم حظر التحقق مؤقتاً بعد تجاوز عدد المحاولات. يرجى طلب رمز جديد',
  captchaFailed:
    'تعذر التحقق من أنك لست روبوتاً. أعد تحميل الصفحة وحاول مرة أخرى',
  invalidInput: 'صيغة المدخلات غير صحيحة',
  passwordResetSuccess: 'تم تعيين كلمة المرور الجديدة بنجاح',
  passwordResetError: 'حدث خطأ أثناء إعادة تعيين كلمة المرور',
  loginSuccess: MSG_LOGIN_SUCCESS,
  // Not collapsed: only a valid recovery code reaches it.
  recoverySecondFactorRequired:
    'تم التحقق من الرمز. أكمل التحقق بخطوتين لتعيين كلمة المرور الجديدة',
  recoveryAttemptsExhausted:
    'تجاوزت عدد المحاولات. يرجى بدء استعادة كلمة المرور من جديد',
  recoveryBlockedByTwoFactor:
    'لا يمكن إعادة تعيين كلمة المرور عبر هذه الوسيلة لأنها نفس وسيلة التحقق بخطوتين. استخدم طريقة تحقق أخرى أو تواصل مع الدعم',
} as const;

/** The contact a code went to, as `processOtpSend`'s `entityName` names it. */
export const CONTACT_LABEL: Readonly<Record<ContactKind, string>> = {
  email: 'البريد الإلكتروني',
  phone: 'رقم الهاتف',
};

// A user who cannot tell a login code from a reset code approves whichever an attacker triggered.
const OTP_PURPOSE_LABEL: Readonly<Record<OtpPurpose, string>> = {
  verify_contact: 'تأكيد وسيلة التواصل',
  forgot_password: 'إعادة تعيين كلمة المرور',
  change_password: 'تغيير كلمة المرور',
  passwordless_login: 'تسجيل الدخول',
  change_email: 'تغيير البريد الإلكتروني',
  change_phone: 'تغيير رقم الهاتف',
  two_factor: 'التحقق بخطوتين',
};

/** The plain-text body on every channel. One line, because SMS is billed per segment. */
export function otpTextFor(purpose: OtpPurpose, code: string): string {
  return `رمز ${OTP_PURPOSE_LABEL[purpose]}: ${code}\nلا تشارك هذا الرمز مع أي شخص`;
}

/** Carries the purpose because the subject is what a user sees before opening. */
export function otpSubjectFor(purpose: OtpPurpose): string {
  return `${OTP_PURPOSE_LABEL[purpose]} — رمز التحقق`;
}

export function otpHtmlFor(code: string): string {
  return `<div dir="rtl" style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h2>رمز التحقق</h2>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">${code}</p>
      <p>صالح لمدة ${countOf(OTP_EXPIRY_MINUTES, MINUTES)}</p>
    </div>`;
}
