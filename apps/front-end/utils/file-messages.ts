export const UPLOAD_FAILED_MESSAGE = 'فشل في رفع الملف';
export const PROCESSING_FAILED_MESSAGE = 'فشلت معالجة الملف';

export const joinFormats = (formats: readonly string[]) => formats.join('، ');

export const fileTooLargeMessage = (name: string, maxSizeMB: number) =>
  `الملف "${name}" كبير جداً (الحد الأقصى: ${maxSizeMB} MB)`;

export const fileInvalidTypeMessage = (
  name: string,
  formats: readonly string[]
) =>
  formats.length > 0
    ? `الملف "${name}" نوعه غير مدعوم، الصيغ المدعومة: ${joinFormats(formats)}`
    : `الملف "${name}" نوعه غير مدعوم`;

export const fileRejectedMessage = (name: string) =>
  `تعذّر قبول الملف "${name}"`;

export const tooManyFilesMessage = (maxFiles: number) =>
  maxFiles === 1
    ? 'يمكن رفع ملف واحد فقط'
    : `يمكنك رفع بحد أقصى ${maxFiles} ملفات فقط`;
