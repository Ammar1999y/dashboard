export const otpMsg = {
  sendSuccess: 'تم إرسال رمز التحقق بنجاح',
  sendError: 'حدث خطأ أثناء إرسال رمز التحقق',
  verifySuccess: (channel: string) =>
    channel === 'email'
      ? 'تم التحقق من البريد الإلكتروني بنجاح'
      : 'تم التحقق من رقم الهاتف بنجاح',
  verifyError: 'حدث خطأ أثناء التحقق من الرمز',
  invalidOrExpired: 'رمز التحقق غير صحيح أو منتهي الصلاحية',
  captchaFailed: 'حدث خطاء اثناء التحقق من انك انسان، اعد المحاولة',
  invalidInput: 'صيغة المدخلات غير صحيحة',
  passwordResetSuccess: 'تم تعيين كلمة المرور الجديدة بنجاح',
  passwordResetError: 'حدث خطأ أثناء إعادة تعيين كلمة المرور',
  loginSuccess: 'تم تسجيل الدخول بنجاح',
  // Not collapsed: only a valid recovery code reaches it.
  recoverySecondFactorRequired:
    'تم التحقق من الرمز. أكمل التحقق بخطوتين لتعيين كلمة المرور الجديدة',
  recoveryBlockedByTwoFactor:
    'لا يمكن إعادة تعيين كلمة المرور عبر هذه الوسيلة لأنها نفس وسيلة التحقق بخطوتين. استخدم طريقة تحقق أخرى أو تواصل مع الدعم',
} as const;

// The user is already known here, so these need not collapse like `otpMsg`.
export const twoFactorMsg = {
  challengeMissing: 'انتهت جلسة التحقق. يرجى تسجيل الدخول من جديد',
  methodUnavailable: 'طريقة التحقق غير متاحة لحسابك',
  contactUnverified: 'يجب تأكيد وسيلة التواصل قبل استخدامها للتحقق بخطوتين',
  codeSent: 'تم إرسال رمز التحقق',
  sendError: 'حدث خطأ أثناء إرسال رمز التحقق',
  invalidCode: 'رمز التحقق غير صحيح أو منتهي الصلاحية',
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
