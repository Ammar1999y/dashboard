import type { ContactKind, OtpPurpose } from '@app/shared/validation/enums';

/** The contact a code went to, as `processOtpSend`'s `entityName` names it. */
export const CONTACT_LABEL: Readonly<Record<ContactKind, string>> = {
  email: 'البريد الإلكتروني',
  phone: 'رقم الهاتف',
};

/**
 * What the code is FOR, in the message that carries it: a user who cannot tell a
 * login code from a password-reset code will approve whichever an attacker
 * triggered.
 */
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
