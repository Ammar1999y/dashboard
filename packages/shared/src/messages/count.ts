/** A counted noun's phrase per Arabic plural category; `#` is the number. */
export interface CountForms {
  readonly one: string;
  readonly two: string;
  readonly few: string;
  readonly many: string;
  readonly other: string;
}

// `few` is 3–10 and `many` 11–99, repeating per hundred (103 is `few`).
const ARABIC_PLURAL = new Intl.PluralRules('ar');

export function countOf(n: number, forms: CountForms): string {
  const category = ARABIC_PLURAL.select(n);
  const form = category === 'zero' ? forms.other : forms[category];
  return form.replace('#', () => String(n));
}

// Each table is written for one grammatical case; the comment names the
// position it fits. A nominative position needs its own table.

// Accusative: «لا يتجاوز …», «يجب أن تكون … على الأقل».
export const CHARACTERS: CountForms = {
  one: 'حرفاً واحداً',
  two: 'حرفين',
  few: '# أحرف',
  many: '# حرفاً',
  other: '# حرف',
};

// Accusative: «يجب أن يكون …».
export const DIGITS: CountForms = {
  one: 'رقماً واحداً',
  two: 'رقمين',
  few: '# أرقام',
  many: '# رقماً',
  other: '# رقم',
};

// Accusative: «يتضمن …».
export const CHARACTERS_OR_DIGITS: CountForms = {
  one: 'حرفاً أو رقماً واحداً',
  two: 'حرفين أو رقمين',
  few: '# أحرف أو أرقام',
  many: '# حرفاً أو رقماً',
  other: '# حرف أو رقم',
};

// Genitive: «تحديد …», «رفع …».
export const FILES: CountForms = {
  one: 'ملف واحد',
  two: 'ملفين',
  few: '# ملفات',
  many: '# ملفاً',
  other: '# ملف',
};

// Nominative: «الحد الأقصى …».
export const FILES_NOMINATIVE: CountForms = { ...FILES, two: 'ملفان' };

// Nominative: «الحد الأقصى …».
export const SESSIONS_NOMINATIVE: CountForms = {
  one: 'جلسة واحدة',
  two: 'جلستان',
  few: '# جلسات',
  many: '# جلسة',
  other: '# جلسة',
};

// Accusative: «لا يتجاوز …».
export const PERMISSIONS: CountForms = {
  one: 'صلاحية واحدة',
  two: 'صلاحيتين',
  few: '# صلاحيات',
  many: '# صلاحية',
  other: '# صلاحية',
};

// Accusative: «الانتظار …».
export const SECONDS: CountForms = {
  one: 'ثانية واحدة',
  two: 'ثانيتين',
  few: '# ثوانٍ',
  many: '# ثانية',
  other: '# ثانية',
};

// Genitive: «لمدة …».
export const MINUTES: CountForms = {
  one: 'دقيقة واحدة',
  two: 'دقيقتين',
  few: '# دقائق',
  many: '# دقيقة',
  other: '# دقيقة',
};

// Genitive: «لمدة …».
export const HOURS: CountForms = {
  one: 'ساعة واحدة',
  two: 'ساعتين',
  few: '# ساعات',
  many: '# ساعة',
  other: '# ساعة',
};

// Genitive: «أكثر من …».
export const ITEMS: CountForms = {
  one: 'عنصر واحد',
  two: 'عنصرين',
  few: '# عناصر',
  many: '# عنصراً',
  other: '# عنصر',
};

// Nominative: «وهو …».
export const ITEMS_NOMINATIVE: CountForms = { ...ITEMS, two: 'عنصران' };

// Accusative: «يتجاوز …».
export const LEVELS: CountForms = {
  one: 'مستوى واحداً',
  two: 'مستويين',
  few: '# مستويات',
  many: '# مستوىً',
  other: '# مستوى',
};

// Genitive: «أكثر من …».
export const SUBFOLDERS: CountForms = {
  one: 'مجلد فرعي واحد',
  two: 'مجلدين فرعيين',
  few: '# مجلدات فرعية',
  many: '# مجلداً فرعياً',
  other: '# مجلد فرعي',
};

// Genitive, after «و» in a list: «مستخدم في: …، و…».
export const OTHER_RECORDS: CountForms = {
  one: 'سجل آخر',
  two: 'سجلين آخرين',
  few: '# سجلات أخرى',
  many: '# سجلاً آخر',
  other: '# سجل آخر',
};

// Genitive: «بعد …».
export const DAYS: CountForms = {
  one: 'يوم واحد',
  two: 'يومين',
  few: '# أيام',
  many: '# يوماً',
  other: '# يوم',
};

// Genitive: «إنهاء …».
export const SESSIONS: CountForms = {
  one: 'جلسة واحدة',
  two: 'جلستين',
  few: '# جلسات',
  many: '# جلسة',
  other: '# جلسة',
};
